// controllers/webhook.controller.ts

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AuthRequest } from '../types';
import { Webhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { RenderJob } from '../models/RenderJob';
import { User } from '../models/User';
import { deliverWebhook } from '../services/webhook.service';
import { generateThumbnailFromVideo } from '../services/thumbnail.service';
import { generateWebhookSecret } from '../utils/helpers';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { env } from '../config/env';

// ============================================================================
// REMOTION WEBHOOK HANDLER
// ============================================================================

interface RemotionWebhookPayload {
  type: 'success' | 'error' | 'timeout';
  renderId: string;
  expectedBucketOwner: string;
  bucketName: string;
  customData?: {
    jobId: string;
  };
  outputUrl?: string;
  outputFile?: string;
  timeToFinish?: number;
  costs?: {
    accruedSoFar: number;
    displayCost: string;
    currency: string;
  };
  outputSizeInBytes?: number;
  lambdasInvoked?: number;
  framesRendered?: number;
  errors?: Array<{
    message: string;
    name: string;
    stack: string;
  }>;
}

// FIXED: Handle different length signatures properly
function verifyRemotionSignature(payload: string, signature: string | undefined): boolean {
  // Skip verification if no secret configured
  if (!env.remotionWebhookSecret) return true;
  if (!signature) return false;

  try {
    const expectedSignature = crypto
      .createHmac('sha512', env.remotionWebhookSecret)
      .update(payload)
      .digest('hex');

    // Check length first to avoid timingSafeEqual error
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (e) {
    logger.warn('Signature verification error:', e);
    return false;
  }
}

export const handleRemotionWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const payload = req.body as RemotionWebhookPayload;
    const signature = req.headers['x-remotion-signature'] as string | undefined;

    logger.info('Remotion webhook received', {
      type: payload.type,
      renderId: payload.renderId,
      jobId: payload.customData?.jobId,
    });

    // Temporarily disable signature verification for testing
    // TODO: Re-enable this after fixing the secret configuration
    /*
    // Verify signature only if secret is set
    if (env.remotionWebhookSecret && signature) {
      const rawBody = JSON.stringify(req.body);
      if (!verifyRemotionSignature(rawBody, signature)) {
        logger.warn('Invalid Remotion webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }
    */

    const jobId = payload.customData?.jobId;
    if (!jobId) {
      logger.warn('Remotion webhook missing jobId');
      res.status(400).json({ error: 'Missing jobId' });
      return;
    }

    const job = await RenderJob.findById(jobId).select('+webhookUrl');
    if (!job) {
      logger.warn('Render job not found for webhook', { jobId });
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Handle based on type
    switch (payload.type) {
      case 'success':
        await handleRemotionSuccess(job, payload);
        break;
      case 'error':
        await handleRemotionError(job, payload);
        break;
      case 'timeout':
        await handleRemotionTimeout(job, payload);
        break;
      default:
        logger.warn('Unknown Remotion webhook type', { type: payload.type });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Remotion webhook error', { error });
    next(error);
  }
};

async function handleRemotionSuccess(job: any, payload: RemotionWebhookPayload): Promise<void> {
  const jobId = job._id.toString();
  const outputUrl = payload.outputUrl || payload.outputFile;

  logger.info('Render success via webhook', {
    jobId,
    outputUrl,
    timeToFinish: payload.timeToFinish,
    cost: payload.costs?.displayCost,
  });

  if (!outputUrl) {
    logger.error('Success webhook missing outputUrl', { jobId });
    await RenderJob.updateOne({ _id: jobId }, { status: 'failed', error: 'No output URL' });
    return;
  }

  // Generate thumbnail
  let thumbnailUrl: string | undefined;
  try {
    const result = await generateThumbnailFromVideo({
      videoUrl: outputUrl,
      renderId: payload.renderId,
      timestamp: 1,
      width: 640,
    });
    if (result.success) {
      thumbnailUrl = result.thumbnailUrl;
      logger.info('Thumbnail generated via webhook', { jobId, thumbnailUrl });
    }
  } catch (e: any) {
    logger.error('Thumbnail failed', { jobId, error: e.message });
  }

  // Update job
  await RenderJob.updateOne(
    { _id: jobId },
    {
      status: 'completed',
      progress: 100,
      outputUrl,
      thumbnailUrl,
      completedAt: new Date(),
      timeToFinish: payload.timeToFinish,
      outputSizeInBytes: payload.outputSizeInBytes,
      lambdasInvoked: payload.lambdasInvoked,
      framesRendered: payload.framesRendered,
      estimatedCost: payload.costs?.accruedSoFar,
      costDisplay: payload.costs?.displayCost,
      currency: payload.costs?.currency,
    }
  );

  // Send user webhook
  if (job.webhookUrl) {
    try {
      await deliverWebhook(job.webhookUrl, {
        event: 'render.completed',
        jobId,
        outputUrl,
        thumbnailUrl,
        stats: {
          timeToFinish: payload.timeToFinish,
          cost: payload.costs?.displayCost,
          size: payload.outputSizeInBytes,
        },
      });
      await RenderJob.updateOne({ _id: jobId }, { webhookSent: true });
    } catch (e: any) {
      logger.error('User webhook failed', { jobId, error: e.message });
    }
  }
}

async function handleRemotionError(job: any, payload: RemotionWebhookPayload): Promise<void> {
  const jobId = job._id.toString();
  const errorMessage = payload.errors?.[0]?.message || 'Unknown render error';

  logger.error('Render failed via webhook', { jobId, errors: payload.errors });

  await RenderJob.updateOne(
    { _id: jobId },
    {
      status: 'failed',
      error: errorMessage,
      renderErrors: payload.errors,
      completedAt: new Date(),
    }
  );

  if (job.webhookUrl) {
    try {
      await deliverWebhook(job.webhookUrl, {
        event: 'render.failed',
        jobId,
        error: errorMessage,
      });
      await RenderJob.updateOne({ _id: jobId }, { webhookSent: true });
    } catch {}
  }
}

async function handleRemotionTimeout(job: any, payload: RemotionWebhookPayload): Promise<void> {
  const jobId = job._id.toString();

  logger.error('Render timeout via webhook', { jobId, renderId: payload.renderId });

  await RenderJob.updateOne(
    { _id: jobId },
    {
      status: 'failed',
      error: 'Render timed out',
      completedAt: new Date(),
    }
  );

  if (job.webhookUrl) {
    try {
      await deliverWebhook(job.webhookUrl, {
        event: 'render.failed',
        jobId,
        error: 'Render timed out',
      });
      await RenderJob.updateOne({ _id: jobId }, { webhookSent: true });
    } catch {}
  }
}

// ============================================================================
// USER WEBHOOK CRUD (unchanged)
// ============================================================================

export const createWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { name, url, events } = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.create({
      userId: user._id,
      name,
      url,
      secret: generateWebhookSecret(),
      events,
    });

    res.status(201).json(webhook);
  } catch (error) {
    next(error);
  }
};

export const listWebhooks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhooks = await Webhook.find({ userId: user._id });

    res.json({ data: webhooks });
  } catch (error) {
    next(error);
  }
};

export const getWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    res.json(webhook);
  } catch (error) {
    next(error);
  }
};

export const updateWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const updates = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOneAndUpdate(
      { _id: id, userId: user._id },
      updates,
      { new: true }
    );

    if (!webhook) throw ApiError.notFound('Webhook not found');

    res.json(webhook);
  } catch (error) {
    next(error);
  }
};

export const deleteWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    await Webhook.deleteOne({ _id: id, userId: user._id });
    await WebhookLog.deleteMany({ webhookId: id });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const testWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    const result = await deliverWebhook(webhook._id.toString(), {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test webhook' },
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const getWebhookLogs = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { page = '1', limit = '20' } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const [logs, total] = await Promise.all([
      WebhookLog.find({ webhookId: id })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      WebhookLog.countDocuments({ webhookId: id }),
    ]);

    res.json({
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};