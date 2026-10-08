// workers/transcription.worker.ts

import { Job } from 'bullmq';
import { Transcription } from '../models/Transcription';
import { createElevenLabsTranscription } from '../services/transcription.service';
import { triggerWebhooks } from '../services/webhook.service';
import { createWorker, createJobLogger, sleep, retryWithBackoff } from '../utils/worker.utils';
import { logger } from '../utils/logger';
import { isFinalAttempt, transition } from '../utils/jobs';
import { releaseUsage, settleUsage } from '../services/usage.service';

// ============================================================================
// Types
// ============================================================================

interface TranscriptionJobData {
  transcriptionId: string;
  fileUrl: string;
  language?: string;
}

// ============================================================================
// Main Processor
// ============================================================================

async function processTranscriptionJob(job: Job<TranscriptionJobData>) {
  const { transcriptionId, fileUrl, language } = job.data;
  const log = createJobLogger('Transcription', transcriptionId);

  log.info('Processing');

  // Load transcription
  const transcription = await Transcription.findById(transcriptionId);
  if (!transcription) {
    log.warn('Not found');
    return { skipped: true, reason: 'not_found' };
  }

  // Skip if already processed
  if (transcription.status === 'completed') {
    log.info('Already completed');
    return { skipped: true, reason: 'completed' };
  }

  if (transcription.status === 'failed') {
    log.info('Already failed');
    return { skipped: true, reason: 'failed' };
  }

  // Validate
  if (!fileUrl) {
    const error = 'File URL required';
    log.error(error);
    await Transcription.updateOne({ _id: transcriptionId }, { status: 'failed', error });
    await releaseUsage('transcriptionMinutes', transcriptionId, 'missing_url');
    return { success: false, reason: 'missing_url' };
  }

  try {
    // Update status
    // Only a transcription still waiting moves to processing (never an edited one).
    await Transcription.updateOne({ _id: transcriptionId, status: { $in: ['pending', 'processing'] } }, { status: 'processing' });

    log.info('Calling ElevenLabs...');

    // Call API with retry
    const result = await retryWithBackoff(
      () => createElevenLabsTranscription(fileUrl, { language }),
      {
        maxRetries: 2,
        initialDelay: 5000,
        maxDelay: 15000,
        onRetry: (err, attempt) => log.warn(`API retry ${attempt}: ${err.message}`),
      }
    );

    log.info(`Completed: ${result.words?.length || 0} words`);

    // Update with results.
    // The `status` filter matters: a user can correct the transcript through
    // PATCH /transcriptions/:id/words while this job is still running, which
    // marks it completed. Without the guard this write would silently replace
    // their edits with the machine transcript.
    await Transcription.updateOne(
      { _id: transcriptionId, status: { $ne: 'completed' }, isEdited: { $ne: true } },
      {
        $unset: { error: '' },
        status: 'completed',
        text: result.text,
        words: result.words,
        speakers: result.utterances,
        duration: result.audio_duration,
        elevenLabsId: result.id,
        processedAt: new Date(),
      }
    );

    // Charge the real audio length (settles the reservation from the request).
    await settleUsage(transcription.userId, 'transcriptionMinutes', transcriptionId, result.audio_duration || 0);

    // Trigger webhooks (async)
    triggerWebhooks(transcription.userId.toString(), 'transcription.completed', {
      transcriptionId,
      text: result.text,
      wordCount: result.words?.length || 0,
      duration: result.audio_duration,
    }).catch((err) => log.warn(`Webhook failed: ${err.message}`));

    return {
      success: true,
      wordCount: result.words?.length || 0,
      duration: result.audio_duration,
    };
  } catch (error: any) {
    log.error(`Failed (attempt ${job.attemptsMade + 1}): ${error.message}`);
    // Only the last attempt marks the record failed; earlier ones leave it
    // "processing" so the queue's retry can still succeed. Never overwrite a
    // transcript the user has already edited (status completed).
    if (isFinalAttempt(job)) {
      await transition(Transcription, transcriptionId, ['pending', 'processing'], {
        status: 'failed',
        error: TRANSCRIPTION_FAILED_MESSAGE,
      });
      await releaseUsage('transcriptionMinutes', transcriptionId, 'transcription_failed');
    }
    throw error;
  }
}

const TRANSCRIPTION_FAILED_MESSAGE = "We couldn't transcribe this file. Try again, or use a file with clearer audio.";

// ============================================================================
// Create Worker
// ============================================================================

const transcriptionWorker = createWorker({
  name: 'transcription',
  processor: processTranscriptionJob,
  // Crashed or stalled for good (e.g. killed mid-call): don't leave it "processing".
  onFinalFailure: async (job) => {
    await transition(Transcription, job.data.transcriptionId, ['pending', 'processing'], {
      status: 'failed',
      error: TRANSCRIPTION_FAILED_MESSAGE,
    });
    await releaseUsage('transcriptionMinutes', job.data.transcriptionId, 'transcription_crashed');
  },
  concurrency: 2, // Low concurrency due to API rate limits
  lockDuration: 300000, // 5 minutes (API can be slow)
});

export default transcriptionWorker;