// workers/transcription.worker.ts

import { Job } from 'bullmq';
import { Transcription } from '../models/Transcription';
import { createElevenLabsTranscription } from '../services/transcription.service';
import { triggerWebhooks } from '../services/webhook.service';
import { createWorker, createJobLogger, sleep, retryWithBackoff } from '../utils/worker.utils';
import { quotaService } from '../services/quota.service';
import { logger } from '../utils/logger';

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
    return { success: false, reason: 'missing_url' };
  }

  try {
    // Update status
    await Transcription.updateOne({ _id: transcriptionId }, { status: 'processing' });

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

    // Update with results
    await Transcription.updateOne(
      { _id: transcriptionId },
      {
        status: 'completed',
        text: result.text,
        words: result.words,
        speakers: result.utterances,
        duration: result.audio_duration,
        elevenLabsId: result.id,
        processedAt: new Date(),
      }
    );

    // Update quota usage
    const userId = transcription.userId.toString();
    const minutesUsed = (result.audio_duration || 0) / 60;
    await quotaService.addTranscriptionMinutes(
      userId,
      minutesUsed,
      transcriptionId
    );

    // Trigger webhooks (async)
    triggerWebhooks(userId, 'transcription.completed', {
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
    log.error(`Failed: ${error.message}`);
    await Transcription.updateOne(
      { _id: transcriptionId },
      { status: 'failed', error: error.message }
    );
    throw error;
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const transcriptionWorker = createWorker({
  name: 'transcription',
  processor: processTranscriptionJob,
  concurrency: 2, // Low concurrency due to API rate limits
  lockDuration: 300000, // 5 minutes (API can be slow)
});

export default transcriptionWorker;