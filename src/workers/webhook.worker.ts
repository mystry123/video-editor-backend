import { Worker, Job } from 'bullmq';
import { redis } from '../config/redis';
import { deliverWebhook } from '../services/webhook.service';
import { logger } from '../utils/logger';

const webhookWorker = new Worker(
  'webhooks',
  async (job: Job) => {
    const { webhookId, payload } = job.data;

    await deliverWebhook(webhookId, payload);
  },
  {
    connection: redis,
    concurrency: 20,
  }
);

webhookWorker.on('failed', (job, err) => {
  logger.error(`Webhook delivery job ${job?.id} failed:`, err);
});

export default webhookWorker;
