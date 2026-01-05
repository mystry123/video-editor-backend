import { Worker, Job } from 'bullmq';
import { redis } from '../config/redis';
import { Transcription } from '../models/Transcription';
import { createElevenLabsTranscription } from '../services/transcription.service';
import { triggerWebhooks } from '../services/webhook.service';
import { logger } from '../utils/logger';

const transcriptionWorker = new Worker(
  'transcription',
  async (job: Job) => {
    const { transcriptionId, fileUrl, language } = job.data;

    try {
      await Transcription.updateOne({ _id: transcriptionId }, { status: 'processing' });

      const result = await createElevenLabsTranscription(fileUrl, { language });

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

      const transcription = await Transcription.findById(transcriptionId);

      await triggerWebhooks(transcription!.userId.toString(), 'transcription.completed', {
        transcriptionId,
        text: result.text,
      });

      logger.info('Transcription completed', { transcriptionId });
    } catch (error: any) {
      logger.error('Transcription failed', { transcriptionId, error: error.message });

      await Transcription.updateOne(
        { _id: transcriptionId },
        {
          status: 'failed',
          error: error.message,
        }
      );

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 5,
  }
);

transcriptionWorker.on('failed', (job, err) => {
  logger.error(`Transcription job ${job?.id} failed:`, err);
});

export default transcriptionWorker;
