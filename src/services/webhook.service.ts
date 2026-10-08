// services/webhook.service.ts
//
// Outgoing webhooks. Everything goes through the `webhooks` queue (5 attempts
// with exponential backoff): a delivery that gets no 2xx answer fails the
// queue job, so it is retried. Two kinds of target:
//   - registered webhooks (Settings → Webhooks), signed with their own secret
//   - a per-render webhookUrl from the render request, signed with the user's
//     webhook signing secret
// Requests go through safeRequest (no private/local addresses, no redirects).

import crypto from 'crypto';
import { BlockedUrlError, safeRequest } from '../utils/safeRequest';
import { Webhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { User } from '../models/User';
import { webhookQueue } from '../queues';
import { createWebhookSignature } from '../utils/helpers';
import { logger } from '../utils/logger';

// Only a snippet of the receiver's reply is kept: enough to debug, not enough
// to use webhooks to read internal services.
const MAX_LOGGED_RESPONSE_CHARS = 300;

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/** Signed POST to `url`. Never throws: the result says what happened. */
async function post(url: string, payload: Record<string, any>, secret: string): Promise<DeliveryResult & { response?: string }> {
  try {
    const response = await safeRequest<string>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': createWebhookSignature(payload, secret),
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
    const success = response.status >= 200 && response.status < 300;
    return {
      success,
      statusCode: response.status,
      response: String(response.data ?? '').slice(0, MAX_LOGGED_RESPONSE_CHARS),
      ...(success ? {} : { error: `Receiver answered ${response.status}` }),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error instanceof BlockedUrlError ? 'Webhook URL points to a private or local address' : error?.message || 'Request failed',
    };
  }
}

/** Delivers to a registered webhook and logs the attempt. */
export async function deliverWebhook(webhookId: string, payload: Record<string, any>): Promise<DeliveryResult> {
  const webhook = await Webhook.findById(webhookId);
  if (!webhook) {
    logger.warn('Webhook not found', { webhookId });
    return { success: false, error: 'Webhook not found' };
  }

  const result = await post(webhook.url, payload, webhook.secret);
  await WebhookLog.create({
    webhookId: webhook._id,
    event: payload.event,
    payload,
    statusCode: result.statusCode,
    response: result.response,
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
  });
  await Webhook.updateOne(
    { _id: webhook._id },
    { lastTriggered: new Date(), $inc: { successCount: result.success ? 1 : 0, failCount: result.success ? 0 : 1 } }
  );
  logger.info('Webhook delivered', { webhookId, success: result.success, statusCode: result.statusCode });
  return { success: result.success, statusCode: result.statusCode, error: result.error };
}

/** The user's secret for per-render webhook URLs, created on first use. */
export async function getWebhookSigningSecret(userId: string): Promise<string> {
  const existing = await User.findById(userId).select('+webhookSigningSecret').lean();
  if (existing?.webhookSigningSecret) return existing.webhookSigningSecret;
  await User.updateOne(
    { _id: userId, webhookSigningSecret: { $exists: false } },
    { $set: { webhookSigningSecret: `whsec_${crypto.randomBytes(24).toString('hex')}` } }
  );
  const created = await User.findById(userId).select('+webhookSigningSecret').lean();
  return created!.webhookSigningSecret!;
}

/** Delivers to a per-render webhook URL. */
export async function deliverToUrl(userId: string, url: string, payload: Record<string, any>): Promise<DeliveryResult> {
  const result = await post(url, payload, await getWebhookSigningSecret(userId));
  logger.info('Render webhook delivered', { userId, success: result.success, statusCode: result.statusCode });
  return { success: result.success, statusCode: result.statusCode, error: result.error };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export interface WebhookJobData {
  /** Registered webhook to deliver to... */
  webhookId?: string;
  /** ...or a per-render URL (with the owner, whose secret signs it). */
  url?: string;
  userId?: string;
  payload: Record<string, any>;
  /** Render job to mark webhookSent on success. */
  renderJobId?: string;
}

/**
 * Queues one delivery. `dedupeKey` makes repeats (a duplicate completion,
 * a retried worker) queue it only once.
 */
async function queueDelivery(data: WebhookJobData, dedupeKey: string): Promise<void> {
  await webhookQueue.add('deliver', data, { jobId: `wh-${dedupeKey}` });
}

/** Queues `event` for every active registered webhook of the user that subscribes to it. */
export async function triggerWebhooks(
  userId: string,
  event: string,
  data: Record<string, any>,
  { dedupeId }: { dedupeId?: string } = {}
): Promise<void> {
  const webhooks = await Webhook.find({ userId, isActive: true, events: event }).select('_id').lean();
  const payload = { event, timestamp: new Date().toISOString(), data };
  for (const webhook of webhooks) {
    await queueDelivery(
      { webhookId: String(webhook._id), payload },
      `${event}-${dedupeId ?? crypto.randomUUID()}-${webhook._id}`
    );
  }
  if (webhooks.length > 0) logger.info(`Queued ${webhooks.length} webhooks for event ${event}`);
}

/** Queues a render event to the render's own webhookUrl (if any) and the user's registered webhooks. */
export async function notifyRenderEvent(
  job: { _id: any; userId: any; webhookUrl?: string },
  event: 'render.completed' | 'render.failed',
  data: Record<string, any>
): Promise<void> {
  const jobId = String(job._id);
  const userId = String(job.userId);
  const body = { jobId, ...data };
  if (job.webhookUrl) {
    await queueDelivery(
      { url: job.webhookUrl, userId, renderJobId: jobId, payload: { event, timestamp: new Date().toISOString(), data: body } },
      `${event}-${jobId}-url`
    );
  }
  await triggerWebhooks(userId, event, body, { dedupeId: jobId });
}
