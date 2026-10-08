import { BlockedUrlError, safeRequest } from '../utils/safeRequest';

// Only a snippet of the receiver's reply is kept: enough to debug, not enough
// to use webhooks to read internal services.
const MAX_LOGGED_RESPONSE_CHARS = 300;
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
    const response = await safeRequest<string>(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
      },
      data: JSON.stringify(payload),
      timeout: 10000,
      maxRedirects: 0,
      maxResponseBytes: 64 * 1024,
      responseType: 'text',
      transformResponse: (body) => body,
      validateStatus: () => true,
    });
    const ok = response.status >= 200 && response.status < 300;
    const responseText = String(response.data ?? '').slice(0, MAX_LOGGED_RESPONSE_CHARS);

    await WebhookLog.create({
      webhookId: webhook._id,
      event: payload.event,
      payload,
      statusCode: response.status,
      response: responseText,
      success: ok,
    });

    await Webhook.updateOne(
      { _id: webhook._id },
      {
        lastTriggered: new Date(),
        $inc: {
          successCount: ok ? 1 : 0,
          failCount: ok ? 0 : 1,
        },
      }
    );

    logger.info('Webhook delivered', { webhookId, success: ok });
    return { success: ok };
  } catch (error: any) {
    await WebhookLog.create({
      webhookId: webhook._id,
      event: payload.event,
      payload,
      success: false,
      error: error instanceof BlockedUrlError ? 'Webhook URL points to a private or local address' : error.message,
    });

    await Webhook.updateOne({ _id: webhook._id }, { $inc: { failCount: 1 } });

    logger.error('Webhook delivery failed', { webhookId, error: error.message });
    throw error;
  }
}
