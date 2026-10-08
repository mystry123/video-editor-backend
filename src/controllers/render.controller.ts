import { Response, NextFunction } from 'express';
import { enqueueJob } from '../utils/jobs';
import { releaseAllUsage, releaseUsage, reserveUsage } from '../services/usage.service';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { RenderJob } from '../models/RenderJob';
import { Template } from '../models/Template';
import { User } from '../models/User';
import { File as FileModel } from '../models/File';
import { renderQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { estimateRenderTime, getPriority } from '../utils/helpers';
import { applyVariables, validateRenderInput } from '../services/renderInput.service';
import { refreshIfStale } from '../services/renderLifecycle.service';
import { snapshotTemplate } from '../services/templateVersion.service';
import { ensureShareTokens, outputFields, publicRender } from '../services/renderOutput.service';
import { logger } from '../utils/logger';
import { getEffectiveQuota } from '../config/quotas';
import { planRenderOutput } from '../utils/renderDimensions';

/** Queues a render job; if the queue is unreachable, marks it failed and returns 503. */
async function queueRender(jobId: string, priority: number): Promise<void> {
  try {
    await enqueueJob(renderQueue, 'render', { jobId }, { jobId: `render-${jobId}`, priority });
  } catch (error) {
    await RenderJob.updateOne({ _id: jobId }, { status: 'failed', error: 'Rendering is temporarily unavailable. Try again in a minute.' });
    await releaseUsage('renderMinutes', jobId, 'enqueue_failed');
    throw error;
  }
}

function assertResolutionAllowed(
  output: ReturnType<typeof planRenderOutput>,
  quota: ReturnType<typeof getEffectiveQuota>
): void {
  if (output.downscaled && quota.overResolution === 'block') {
    throw ApiError.withCode(
      403,
      'RESOLUTION_NOT_ALLOWED',
      `This project is larger than ${quota.maxResolution}, the highest resolution on your plan. Lower the project size or upgrade.`
    );
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** What every render start (new or repeated) returns. */
function startResponse(job: any, output: { resolution: string; downscaled: boolean }, warnings: string[] = [], deduplicated = false) {
  return {
    id: job._id,
    status: job.status,
    estimatedTime: estimateRenderTime(job.inputProps || {}),
    resolution: output.resolution,
    downscaled: output.downscaled,
    templateVersion: job.templateVersion,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(deduplicated ? { deduplicated: true } : {}),
  };
}

export const startRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { templateId, webhookUrl, variables, version } = req.body as {
      templateId: string;
      webhookUrl?: string | null;
      variables?: Record<string, unknown>;
      version?: number;
    };
    if (!templateId) throw ApiError.badRequest('templateId is required');

    // A repeated request (double click, network retry) gets the job it already started.
    const rawKey = req.get('Idempotency-Key') ?? req.body?.idempotencyKey;
    const idempotencyKey = typeof rawKey === 'string' && rawKey !== '' ? rawKey : undefined;
    if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw ApiError.withCode(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-100 letters, digits, "-" or "_".');
    }
    const findRepeat = async () =>
      idempotencyKey ? RenderJob.findOne({ userId, idempotencyKey }).select('+inputProps') : null;
    const repeat = await findRepeat();
    if (repeat) {
      res.status(200).json(startResponse(repeat, { resolution: repeat.resolution, downscaled: (repeat.scale ?? 1) < 1 }, [], true));
      return;
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({
      _id: templateId,
      $or: [{ userId: user._id }, { isPublic: true }],
    });
    if (!template) throw ApiError.notFound('Template not found');

    // Render exactly the version the editor saved. If the template changed
    // since (another tab, a slow save), the editor saves again and retries.
    if (version !== undefined && version !== template.version) {
      throw ApiError.withCode(
        409,
        'STALE_VERSION',
        'The project changed since it was saved. Save again and retry.',
        { currentVersion: template.version, requestedVersion: version }
      );
    }

    // Snapshot of that version: later edits don't change this render.
    const inputProps = JSON.parse(JSON.stringify(template.data || {}));
    const applied = applyVariables(inputProps.elements, variables);
    inputProps.elements = applied.elements;
    validateRenderInput(inputProps);

    const project = inputProps.project;
    const fps = Number(project.fps) || 30;
    const outputFormat = project.outputFormat || 'mp4';

    // Plans cap output resolution: above the cap is downscaled or blocked,
    // depending on the plan's policy.
    const quota = getEffectiveQuota(user);
    const output = planRenderOutput(Number(project.width), Number(project.height), quota.maxResolution);
    assertResolutionAllowed(output, quota);

    // Reserve the render minutes up front (atomic against the monthly limit),
    // so parallel requests can't all slip under it. Refunded if it fails.
    const renderJobId = new Types.ObjectId();
    await reserveUsage(user._id, 'renderMinutes', String(renderJobId), Number(project.duration), quota.maxRenderMinutes);

    let renderJob;
    try {
      renderJob = await RenderJob.create({
        _id: renderJobId,
        userId: user._id,
        templateId: template._id,
        templateVersion: template.version,
        idempotencyKey,
        inputProps,
        outputFormat,
        resolution: output.resolution,
        scale: output.scale,
        fps,
        renderType: 'Template',
        webhookUrl,
        variables: variables && Object.keys(variables).length > 0 ? variables : undefined,
        status: 'pending',
      });
    } catch (error: any) {
      await releaseUsage('renderMinutes', String(renderJobId), 'not_created');
      // A parallel request with the same key won the race: return its job.
      const winner = error?.code === 11000 ? await findRepeat() : null;
      if (winner) {
        res.status(200).json(startResponse(winner, output, [], true));
        return;
      }
      throw error;
    }

    await queueRender(renderJob._id.toString(), getPriority(user.role));
    await Template.updateOne({ _id: template._id }, { $inc: { usageCount: 1 } });
    // Version history keeps every rendered state (owner's templates only).
    if (String(template.userId) === String(user._id)) await snapshotTemplate(template, user._id, 'render');

    logger.info('Job added to render queue', { jobId: renderJob._id.toString(), templateVersion: template.version });

    const warnings = applied.unmatched.map((name) => `Variable "${name}" doesn't match any element name, so it was ignored.`);
    res.status(202).json(startResponse(renderJob, output, warnings));
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// Reframe render — synthesizes inputProps from a File doc's saved reframe data
// (zones + keyframes already written by the reframe worker) so the user can
// turn the AI-cropped preview into an MP4 without going through a Template.
// ============================================================================

const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
};

export const startReframeRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { fileId, aspectRatio, webhookUrl } = req.body as {
      fileId?: string;
      aspectRatio?: string;
      webhookUrl?: string | null;
    };

    if (!fileId || !aspectRatio) {
      throw ApiError.badRequest('fileId and aspectRatio are required');
    }

    const dims = ASPECT_DIMENSIONS[aspectRatio];
    if (!dims) {
      throw ApiError.badRequest(`unsupported aspectRatio: ${aspectRatio}`);
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file: any = await FileModel.findOne({ _id: fileId, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    const reframeKey = aspectRatio.replace(':', '_');
    const reframeBlob =
      file.reframe?.get?.(reframeKey) ||
      (file.reframe && file.reframe[reframeKey]);

    if (!reframeBlob || reframeBlob.status !== 'completed' || !reframeBlob.zones?.length) {
      throw ApiError.badRequest(
        `No completed reframe data for ${aspectRatio}. Run AI Reframe first.`
      );
    }

    const fps = reframeBlob.fps || 30;
    const duration = file.metadata?.duration || 10;

    // Build a minimal Remotion-compatible inputProps that mirrors what a Template
    // would have produced: project settings sized to the target ratio, plus a
    // single full-canvas video element carrying the reframeData (zones).
    const videoUrl = file.cdnUrl || file.url;
    const inputProps = {
      project: {
        width: dims.width,
        height: dims.height,
        fps,
        duration,
        backgroundColor: '#000000',
        outputFormat: 'mp4',
      },
      elements: [
        {
          id: `reframe-video-${Date.now()}`,
          type: 'video',
          source: videoUrl,
          fileId: String(file._id),
          time: 0,
          duration,
          track: 1,
          width: '100%',
          height: '100%',
          x: '50%',
          y: '50%',
          anchorX: 50,
          anchorY: 50,
          fit: 'fill',
          visible: true,
          opacity: 1,
          reframeData: {
            activeRatio: aspectRatio,
            layoutType: reframeBlob.layoutDecision?.layout_type,
            reasoning: reframeBlob.layoutDecision?.reasoning,
            confidence: reframeBlob.layoutDecision?.confidence,
            zones: reframeBlob.zones,
            sceneStats: reframeBlob.sceneStats,
          },
        },
      ],
    };

    const reframeQuota = getEffectiveQuota(user);
    const reframeOutput = planRenderOutput(dims.width, dims.height, reframeQuota.maxResolution);
    assertResolutionAllowed(reframeOutput, reframeQuota);

    const reframeJobId = new Types.ObjectId();
    await reserveUsage(user._id, 'renderMinutes', String(reframeJobId), Number(duration), reframeQuota.maxRenderMinutes);

    const renderJob = await RenderJob.create({
      _id: reframeJobId,
      userId: user._id,
      inputProps,
      outputFormat: 'mp4',
      resolution: reframeOutput.resolution,
      scale: reframeOutput.scale,
      fps,
      // Re-use the existing 'Template' code path in the render worker — the worker
      // reads inputProps directly and doesn't otherwise care about a Template doc.
      renderType: 'Template',
      webhookUrl,
      status: 'pending',
    });

    await queueRender(renderJob._id.toString(), getPriority(user.role));

    logger.info('Reframe render queued', {
      jobId: renderJob._id.toString(),
      fileId,
      aspectRatio,
    });

    res.status(202).json({
      id: renderJob._id,
      status: renderJob.status,
      estimatedTime: estimateRenderTime(inputProps),
    });
  } catch (error) {
    next(error);
  }
};

export const getRenderStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    let job = await RenderJob.findOne({ _id: id, userId: user._id });
    if (!job) throw ApiError.notFound('Render job not found');

    // While someone is watching, read fresh progress from Lambda (throttled).
    // In webhook mode nothing else updates it, and this also completes a
    // render whose webhook got lost.
    if (await refreshIfStale(job)) {
      job = (await RenderJob.findById(job._id)) ?? job;
    }

    const [linked] = await ensureShareTokens([job.toObject()]);
    res.json({
      id: job._id,
      status: job.status,
      progress: job.progress,
      ...outputFields(linked),
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    next(error);
  }
};

export const streamProgress = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    // Only the job's owner may stream it. (CORS is handled by the global
    // cors() allowlist; this used to echo any Origin with credentials.)
    if (!Types.ObjectId.isValid(id) || !(await RenderJob.exists({ _id: id, userId: req.userId }))) {
      throw ApiError.notFound('Render job not found');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let intervalId: NodeJS.Timeout | null = null;
    let isClosed = false;

    const sendUpdate = async () => {
      if (isClosed) return;

      try {
        const job = await RenderJob.findOne({ _id: id, userId: req.userId });
        
        if (!job) {
          res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
          res.end();
          return;
        }

        const [linked] = await ensureShareTokens([job.toObject()]);
        res.write(
          `data: ${JSON.stringify({
            id: job._id,
            status: job.status,
            progress: job.progress,
            ...outputFields(linked),
            error: job.error,
          })}\n\n`
        );

        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          if (intervalId) clearInterval(intervalId);
          res.end();
          return;
        }
      } catch (error) {
        console.error('Error in sendUpdate:', error);
        if (intervalId) clearInterval(intervalId);
        res.end();
      }
    };

    // Send initial update
    await sendUpdate();

    // Set up polling
    intervalId = setInterval(sendUpdate, 1000);

    // Clean up on connection close
    req.on('close', () => {
      isClosed = true;
      if (intervalId) clearInterval(intervalId);
      res.end();
    });

    res.on('close', () => {
      isClosed = true;
      if (intervalId) clearInterval(intervalId);
    });

  } catch (error) {
    next(error);
  }
};

export const cancelRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const job = await RenderJob.findOne({
      _id: id,
      userId: user._id,
      status: { $in: ['pending', 'queued', 'rendering'] },
    });

    if (!job) throw ApiError.notFound('Job not found or cannot be cancelled');

    const cancelled = await RenderJob.findOneAndUpdate(
      { _id: id, status: { $in: ['pending', 'queued', 'rendering'] } },
      { status: 'cancelled', completedAt: new Date() }
    );
    // Refund the reserved minutes (no-op if the render already completed and was charged).
    if (cancelled) await releaseAllUsage(String(cancelled._id), 'cancelled');

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const listRenderJobs = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { status, page = '1', limit = '20' } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const query: any = { userId: user._id };
    if (status) query.status = status;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const [jobs, total] = await Promise.all([
      RenderJob.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      RenderJob.countDocuments(query),
    ]);

    await ensureShareTokens(jobs);
    res.json({
      data: jobs.map((job) => publicRender(job)),
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

// Zapier-friendly endpoints
export const zapierRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  req.body.templateId = req.body.template_id;
  // Zapier's dynamic data are the template variables.
  req.body.variables = req.body.variables ?? req.body.dynamic_data;
  req.body.webhookUrl = req.body.webhook_url;

  return startRender(req, res, next);
};

export const zapierPoll = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const job = await RenderJob.findOne({ _id: id, userId: user._id });
    if (!job) throw ApiError.notFound('Job not found');

    if (job.status === 'completed') {
      const [linked] = await ensureShareTokens([job.toObject()]);
      res.json({
        id: job._id,
        status: 'complete',
        output_url: outputFields(linked).outputUrl,
        completed_at: job.completedAt,
      });
      return;
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      // A final state: tell Zapier so it stops polling.
      res.json({ id: job._id, status: job.status, error: job.error || (job.status === 'cancelled' ? 'The render was cancelled.' : 'The render failed.') });
      return;
    }

    res.status(202).json({ status: 'pending' });
  } catch (error) {
    next(error);
  }
};
