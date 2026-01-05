import { Queue, QueueEvents } from 'bullmq';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const defaultJobOptions = {
  removeOnComplete: 100,
  removeOnFail: 50,
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
};

export const renderQueue = new Queue('render', {
  connection: redis,
  defaultJobOptions,
});

export const transcriptionQueue = new Queue('transcription', {
  connection: redis,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2,
  },
});

export const fileProcessingQueue = new Queue('file-processing', {
  connection: redis,
  defaultJobOptions,
});

export const webhookQueue = new Queue('webhooks', {
  connection: redis,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: {
      type: 'exponential' as const,
      delay: 1000,
    },
  },
});

// Log queue events
const queues = [renderQueue, transcriptionQueue, fileProcessingQueue, webhookQueue];

queues.forEach((queue) => {
  const events = new QueueEvents(queue.name, { connection: redis });

  events.on('completed', ({ jobId }) => {
    logger.debug(`Job ${jobId} completed in ${queue.name}`);
  });

  events.on('failed', ({ jobId, failedReason }) => {
    logger.error(`Job ${jobId} failed in ${queue.name}: ${failedReason}`);
  });
});

export function startWorkers(): void {
  require('../workers/render.worker');
  require('../workers/transcription.worker');
  require('../workers/file.worker');
  require('../workers/webhook.worker');
  logger.info('All workers started');
}
