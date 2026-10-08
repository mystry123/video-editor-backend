// workers/webhook.worker.ts
//
// Delivers one queued webhook. A failed delivery throws, so BullMQ retries it
// with the queue's backoff (5 attempts) instead of holding this slot.

import { Job } from 'bullmq';
import { deliverToUrl, deliverWebhook, type WebhookJobData } from '../services/webhook.service';
import { RenderJob } from '../models/RenderJob';
import { createWorker, createJobLogger } from '../utils/worker.utils';

async function processWebhookJob(job: Job<WebhookJobData>) {
  const { webhookId, url, userId, payload, renderJobId } = job.data;
  const log = createJobLogger('Webhook', String(webhookId || renderJobId || job.id).slice(-8));

  if (!payload || (!webhookId && !(url && userId))) {
    log.error('Missing target or payload');
    return { success: false, error: 'Missing webhook target' };
  }

  const result = webhookId ? await deliverWebhook(webhookId, payload) : await deliverToUrl(userId!, url!, payload);
  if (!result.success) {
    log.warn(`Attempt ${job.attemptsMade + 1} failed: ${result.error}`);
    throw new Error(result.error || 'Webhook delivery failed');
  }
  if (renderJobId) await RenderJob.updateOne({ _id: renderJobId }, { webhookSent: true });
  log.info(`Delivered ${payload.event}`);
  return { success: true, statusCode: result.statusCode };
}

const webhookWorker = createWorker({
  name: 'webhooks',
  processor: processWebhookJob,
  concurrency: 10,
  lockDuration: 60000,
});

export default webhookWorker;
