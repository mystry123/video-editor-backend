import { Worker, Job } from 'bullmq';
import { redis } from '../config/redis';
import { File } from '../models/File';
import { logger } from '../utils/logger';

const fileWorker = new Worker(
  'file-processing',
  async (job: Job) => {
    const { fileId } = job.data;

    try {
      const file = await File.findById(fileId);
      if (!file) {
        logger.warn('File not found for processing', { fileId });
        return;
      }

      // TODO: Implement actual file processing
      // - Extract metadata using ffprobe for video/audio
      // - Generate thumbnails for videos
      // - Extract dimensions for images

      let metadata: any = {};

      if (file.mimeType.startsWith('image/')) {
        // Process image - extract dimensions
        metadata = {
          width: 1920, // TODO: Get actual dimensions
          height: 1080,
        };
      } else if (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')) {
        // Process video/audio - extract duration, codec, etc.
        metadata = {
          duration: 10, // TODO: Get actual duration
          codec: 'h264',
        };
      }

      await File.updateOne(
        { _id: fileId },
        {
          status: 'ready',
          metadata,
        }
      );

      logger.info('File processed', { fileId });
    } catch (error: any) {
      logger.error('File processing failed', { fileId, error: error.message });

      await File.updateOne(
        { _id: fileId },
        {
          status: 'error',
        }
      );

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 10,
  }
);

fileWorker.on('failed', (job, err) => {
  logger.error(`File processing job ${job?.id} failed:`, err);
});

export default fileWorker;
