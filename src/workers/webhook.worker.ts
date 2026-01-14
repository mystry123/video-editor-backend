// workers/webhook.worker.ts

import { Job } from 'bullmq';
import { deliverWebhook } from '../services/webhook.service';
import { createWorker, createJobLogger, retryWithBackoff } from '../utils/worker.utils';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

interface WebhookJobData {
  webhookId?: string;
  webhookUrl?: string;
  payload: Record<string, any>;
  event?: string;
}

// ============================================================================
// Main Processor
// ============================================================================

async function processWebhookJob(job: Job<WebhookJobData>) {
  const { webhookId, webhookUrl, payload, event } = job.data;
  const targetId = webhookId || webhookUrl || 'unknown';
  const log = createJobLogger('Webhook', targetId.slice(-8));

  log.info(`Delivering: ${event || 'unknown'}`);

  // Validate
  if (!webhookId && !webhookUrl) {
    log.error('Missing target');
    return { success: false, error: 'Missing webhook target' };
  }

  if (!payload) {
    log.error('Missing payload');
    return { success: false, error: 'Missing payload' };
  }

  try {
    // Deliver with retry
    await retryWithBackoff(
      () => deliverWebhook(webhookId || webhookUrl!, payload),
      {
        maxRetries: 5,
        initialDelay: 3000,
        maxDelay: 60000,
        onRetry: (err, attempt) => log.warn(`Retry ${attempt}: ${err.message}`),
      }
    );

    log.info('Delivered');
    return { success: true };
  } catch (error: any) {
    log.error(`Failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const webhookWorker = createWorker({
  name: 'webhooks',
  processor: processWebhookJob,
  concurrency: 5,
  lockDuration: 60000,
});

export default webhookWorker;