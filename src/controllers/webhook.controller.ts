// controllers/webhook.controller.ts
import { sendError } from '../utils/errorResponse';
import { validateWebhookSignature } from '@remotion/lambda-client';
import { isTrustedMediaUrl } from '../utils/media';

import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { Webhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { RenderJob } from '../models/RenderJob';
import { Types } from 'mongoose';
import { RENDER_TIMEOUT_MESSAGE, completeRender, describeRenderError, failRender } from '../services/renderLifecycle.service';
import { User } from '../models/User';
import { deliverWebhook, getWebhookSigningSecret } from '../services/webhook.service';
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

    // Fail closed: without a secret there's no way to tell Remotion from anyone
    // else, so the endpoint doesn't exist (renders then complete by polling).
    if (!env.remotionWebhookSecret) {
      sendError(req, res, 404, 'Not found', 'ROUTE_NOT_FOUND');
      return;
    }
    try {
      validateWebhookSignature({ secret: env.remotionWebhookSecret, body: req.body, signatureHeader: signature as string });
    } catch {
      logger.warn('Invalid Remotion webhook signature');
      sendError(req, res, 401, 'Invalid signature', 'INVALID_SIGNATURE');
      return;
    }

    const jobId = payload.customData?.jobId;
    if (!jobId) {
      logger.warn('Remotion webhook missing jobId');
      sendError(req, res, 400, 'Missing jobId', 'BAD_REQUEST');
      return;
    }

    const job = Types.ObjectId.isValid(String(jobId)) ? await RenderJob.findById(jobId) : null;
    if (!job) {
      logger.warn('Render job not found for webhook', { jobId });
      sendError(req, res, 404, 'Job not found', 'NOT_FOUND');
      return;
    }

    // Even a correctly signed payload must match the job it claims to be about,
    // and may only point at our own storage.
    // (The webhook can arrive before the worker saved renderId; customData's
    // jobId, covered by the signature, identifies the job then.)
    if (job.renderId && payload.renderId && job.renderId !== payload.renderId) {
      logger.warn('Remotion webhook renderId mismatch', { jobId });
      sendError(req, res, 409, 'Render id does not match job', 'CONFLICT');
      return;
    }
    if (payload.type === 'success' && payload.outputUrl && !isTrustedMediaUrl(payload.outputUrl)) {
      logger.warn('Remotion webhook outputUrl not on trusted storage', { jobId });
      sendError(req, res, 400, 'Untrusted output URL', 'BAD_REQUEST');
      return;
    }

    // Outcomes are conditional transitions: a duplicate or late webhook is a no-op.
    const id = String(job._id);
    switch (payload.type) {
      case 'success': {
        const outputUrl = payload.outputUrl || payload.outputFile;
        if (!outputUrl) {
          await failRender(id, describeRenderError(), 'render_failed');
          break;
        }
        if (!job.renderId && payload.renderId) {
          await RenderJob.updateOne({ _id: id, status: 'rendering' }, { renderId: payload.renderId, bucketName: payload.bucketName });
        }
        await completeRender(id, {
          outputUrl,
          stats: {
            timeToFinish: payload.timeToFinish,
            estimatedCost: payload.costs?.accruedSoFar,
            costDisplay: payload.costs?.displayCost,
            currency: payload.costs?.currency,
          },
        });
        break;
      }
      case 'error':
        await failRender(id, describeRenderError(payload.errors?.[0]?.message), 'render_failed', { renderErrors: payload.errors });
        break;
      case 'timeout':
        await failRender(id, RENDER_TIMEOUT_MESSAGE, 'render_timeout');
        break;
      default:
        logger.warn('Unknown Remotion webhook type', { type: (payload as any).type });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Remotion webhook error', { error });
    next(error);
  }
};

// GET /webhooks/signing-secret - verifies X-Webhook-Signature on deliveries to
// a render's webhookUrl: HMAC-SHA256 of the JSON body with this secret.
export const getSigningSecret = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ secret: await getWebhookSigningSecret(req.userId!), algorithm: 'HMAC-SHA256', header: 'X-Webhook-Signature' });
  } catch (error) {
    next(error);
  }
};

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
    // Whitelisted fields only. Passing req.body straight through let a request
    // set userId (redirecting another account's events to this endpoint),
    // the signing secret, counters, or update operators.
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'url', 'events', 'isActive'] as const) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOneAndUpdate(
      { _id: id, userId: user._id },
      { $set: updates },
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