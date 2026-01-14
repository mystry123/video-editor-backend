import fetch from 'node-fetch';
import { Webhook, IWebhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { webhookQueue } from '../queues';
import { createWebhookSignature } from '../utils/helpers';
import { logger } from '../utils/logger';

export async function triggerWebhooks(
  userId: string,
  event: string,
  data: Record<string, any>
): Promise<void> {
  const webhooks = await Webhook.find({
    userId,
    isActive: true,
    events: event,
  });

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  // Queue webhook deliveries
  for (const webhook of webhooks) {
    await webhookQueue.add('deliver', {
      webhookId: webhook._id.toString(),
      payload,
    });
  }

  logger.info(`Queued ${webhooks.length} webhooks for event ${event}`);
}

export async function deliverWebhook(
  webhookId: string,
  payload: any
): Promise<{ success: boolean }> {
  const webhook = await Webhook.findById(webhookId);
  if (!webhook) {
    logger.warn('Webhook not found', { webhookId });
    return { success: false };
  }

  const signature = createWebhookSignature(payload, webhook.secret);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
      },
      body: JSON.stringify(payload),
      signal: controller.signal as any,
    });

    clearTimeout(timeout);

    const responseText = await response.text();

    await WebhookLog.create({
      webhookId: webhook._id,
      event: payload.event,
      payload,
      statusCode: response.status,
      response: responseText,
      success: response.ok,
    });

    await Webhook.updateOne(
      { _id: webhook._id },
      {
        lastTriggered: new Date(),
        $inc: {
          successCount: response.ok ? 1 : 0,
          failCount: response.ok ? 0 : 1,
        },
      }
    );

    logger.info('Webhook delivered', { webhookId, success: response.ok });
    return { success: response.ok };
  } catch (error: any) {
    await WebhookLog.create({
      webhookId: webhook._id,
      event: payload.event,
      payload,
      success: false,
      error: error.message,
    });

    await Webhook.updateOne({ _id: webhook._id }, { $inc: { failCount: 1 } });

    logger.error('Webhook delivery failed', { webhookId, error: error.message });
    throw error;
  }
}
