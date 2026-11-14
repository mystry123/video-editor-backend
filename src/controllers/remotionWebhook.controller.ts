// controllers/remotionWebhook.controller.ts
//
// POST /api/v1/webhooks/remotion: Remotion Lambda reports a render's outcome
// (RENDER_PROVIDER=lambda in webhook mode). Restored from the pre-GCP code
// (before commit 240893d). Every request must carry a valid
// X-Remotion-Signature for REMOTION_WEBHOOK_SECRET; outcomes go through
// renderLifecycle.service like every other render path.

import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { validateWebhookSignature } from '@remotion/lambda-client';
import { RenderJob } from '../models/RenderJob';
import { RENDER_TIMEOUT_MESSAGE, completeRender, describeRenderError, failRender } from '../services/renderLifecycle.service';
import { webhookMode } from '../services/lambdaRender.service';
import { isTrustedMediaUrl } from '../utils/media';
import { sendError } from '../utils/errorResponse';
import { logger } from '../utils/logger';
import { env } from '../config/env';

interface RemotionWebhookPayload {
  type: 'success' | 'error' | 'timeout';
  renderId: string;
  expectedBucketOwner: string;
  bucketName: string;
  customData?: { jobId: string };
  outputUrl?: string;
  outputFile?: string;
  timeToFinish?: number;
  costs?: { accruedSoFar: number; displayCost: string; currency: string };
  outputSizeInBytes?: number;
  lambdasInvoked?: number;
  framesRendered?: number;
  errors?: Array<{ message: string; name: string; stack: string }>;
}

export const handleRemotionWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Fail closed: without Lambda in webhook mode there's no secret to tell
    // Remotion from anyone else, so the endpoint doesn't exist.
    if (!webhookMode()) {
      sendError(req, res, 404, 'Not found', 'ROUTE_NOT_FOUND');
      return;
    }
    const payload = req.body as RemotionWebhookPayload;
    const signature = req.headers['x-remotion-signature'] as string | undefined;
    try {
      validateWebhookSignature({ secret: env.remotionWebhookSecret, body: req.body, signatureHeader: signature as string });
    } catch {
      logger.warn('Invalid Remotion webhook signature');
      sendError(req, res, 401, 'Invalid signature', 'INVALID_SIGNATURE');
      return;
    }

    logger.info('Remotion webhook received', { type: payload.type, renderId: payload.renderId, jobId: payload.customData?.jobId });

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
    const reportedOutput = payload.outputUrl || payload.outputFile;
    if (payload.type === 'success' && reportedOutput && !isTrustedMediaUrl(reportedOutput)) {
      logger.warn('Remotion webhook outputUrl not on trusted storage', { jobId });
      sendError(req, res, 400, 'Untrusted output URL', 'BAD_REQUEST');
      return;
    }

    // Outcomes are conditional transitions: a duplicate or late webhook is a no-op.
    const id = String(job._id);
    switch (payload.type) {
      case 'success': {
        if (!reportedOutput) {
          await failRender(id, describeRenderError(), 'render_failed');
          break;
        }
        if (!job.renderId && payload.renderId) {
          await RenderJob.updateOne({ _id: id, status: 'rendering' }, { renderId: payload.renderId, bucketName: payload.bucketName });
        }
        await completeRender(id, {
          outputUrl: reportedOutput,
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
