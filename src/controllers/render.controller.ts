import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { RenderJob } from '../models/RenderJob';
import { Template } from '../models/Template';
import { User } from '../models/User';
import { File as FileModel } from '../models/File';
import { renderQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { deepMerge, estimateRenderTime, getPriority } from '../utils/helpers';
import { logger } from '../utils/logger';
import { getEffectiveQuota } from '../config/quotas';
import { planRenderOutput } from '../utils/renderDimensions';

const MEDIA_ELEMENT_TYPES = new Set(['image', 'video', 'audio', 'gif', 'lottie']);

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

// Must match the codec map in services/render.service.ts.
const SUPPORTED_OUTPUT_FORMATS = new Set(['mp4', 'webm', 'gif']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyVariablesToElements(
  elements: any[],
  variables: Record<string, unknown>
): any[] {
  if (!Array.isArray(elements)) return elements;

  return elements.map((element) => {
    if (!element || typeof element !== 'object') return element;
    const name = element.name;
    if (!name || !(name in variables)) return element;

    const override = variables[name];
    const elementType: string = element.type;

    if (isPlainObject(override)) {
      return deepMerge(element, override);
    }

    if (elementType === 'text' || elementType === 'caption') {
      return { ...element, text: String(override) };
    }

    if (MEDIA_ELEMENT_TYPES.has(elementType)) {
      if (!isHttpUrl(override)) {
        throw ApiError.badRequest(
          `variables.${name}: media override must be an http(s) URL`
        );
      }
      const srcKey = elementType === 'lottie' || elementType === 'gif' ? 'source' : 'src';
      return { ...element, [srcKey]: override };
    }

    return { ...element, value: override };
  });
}

export const startRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const {
      templateId,
      webhookUrl,
      variables,
    } = req.body as {
      templateId?: string;
      webhookUrl?: string | null;
      variables?: Record<string, unknown>;
    };

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    let inputProps;
    let template = null;

    if (templateId) {
      template = await Template.findOne({
        _id: templateId,
        $or: [{ userId: user._id }, { isPublic: true }],
      });

      if (!template) throw ApiError.notFound('Template not found');

      inputProps = JSON.parse(JSON.stringify(template.data));

      await Template.updateOne({ _id: templateId }, { $inc: { usageCount: 1 } });
    } else {
      throw ApiError.badRequest('templateId is required');
    }

    if (variables && Object.keys(variables).length > 0) {
      inputProps.elements = applyVariablesToElements(inputProps.elements, variables);
    }

    // Get render settings from template project settings or use defaults
    const project = template?.data?.project || {};
    const fps = project.fps || 30;
    const outputFormat = project.outputFormat || 'mp4';
    if (!SUPPORTED_OUTPUT_FORMATS.has(outputFormat)) {
      throw new ApiError(422, `Exporting as ${outputFormat} isn't supported yet. Choose MP4, WebM or GIF.`);
    }
    if (!(Number(project.duration) > 0) || !(Number(project.width) > 0) || !(Number(project.height) > 0)) {
      throw new ApiError(422, 'This project has no duration or size set. Add content to the timeline and try again.');
    }

    // Plans cap output resolution: above the cap is downscaled or blocked,
    // depending on the plan's policy.
    const quota = getEffectiveQuota(user);
    const output = planRenderOutput(Number(project.width), Number(project.height), quota.maxResolution);
    assertResolutionAllowed(output, quota);

    const renderJob = await RenderJob.create({
      userId: user._id,
      templateId: template?._id,
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

    await renderQueue.add(
      'render',
      { jobId: renderJob._id.toString() },
      { priority: getPriority(user.role) }
    );

    logger.info('Job added to render queue', { jobId: renderJob._id.toString() });

    res.status(202).json({
      id: renderJob._id,
      status: renderJob.status,
      estimatedTime: estimateRenderTime(inputProps),
      resolution: output.resolution,
      downscaled: output.downscaled,
    });
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

    const renderJob = await RenderJob.create({
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

    await renderQueue.add(
      'render',
      { jobId: renderJob._id.toString() },
      { priority: getPriority(user.role) }
    );

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

    const job = await RenderJob.findOne({ _id: id, userId: user._id });
    if (!job) throw ApiError.notFound('Render job not found');


    res.json({
      id: job._id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.outputUrl,
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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    let intervalId: NodeJS.Timeout | null = null;
    let isClosed = false;

    const sendUpdate = async () => {
      if (isClosed) return;

      try {
        const job = await RenderJob.findById(id);
        
        if (!job) {
          res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
          res.end();
          return;
        }

        res.write(
          `data: ${JSON.stringify({
            id: job._id,
            status: job.status,
            progress: job.progress,
            outputUrl: job.outputUrl,
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

    await RenderJob.updateOne({ _id: id }, { status: 'cancelled' });

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

    res.json({
      data: jobs,
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
  req.body.dynamicData = req.body.dynamic_data;
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
      res.json({
        id: job._id,
        status: 'complete',
        output_url: job.outputUrl,
        completed_at: job.completedAt,
      });
      return;
    }

    res.status(202).json({ status: 'pending' });
  } catch (error) {
    next(error);
  }
};
