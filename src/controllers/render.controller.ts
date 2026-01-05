import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { RenderJob } from '../models/RenderJob';
import { Template } from '../models/Template';
import { User } from '../models/User';
import { renderQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { deepMerge, estimateRenderTime, getPriority } from '../utils/helpers';

export const startRender = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    console.log('Render request received:', req.body);
    const userId = req.userId!;
    const {
      templateId,
      webhookUrl,
    } = req.body;

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

      inputProps = { ...template.data };

      await Template.updateOne({ _id: templateId }, { $inc: { usageCount: 1 } });
    } else {
      throw ApiError.badRequest('templateId is required');
    }

    // No dynamicData handling needed since we're using template data only

    // Get render settings from template project settings or use defaults
    const fps = template?.data?.project?.fps || 30;
    const outputFormat = template?.data?.project?.outputFormat || 'mp4';
    const resolution = template?.data?.project ? `${template.data.project.height}p` : '1080p';

    const renderJob = await RenderJob.create({
      userId: user._id,
      templateId: template?._id,
      inputProps,
      outputFormat,
      resolution,
      fps,
      webhookUrl,
      status: 'pending',
    });

    await renderQueue.add(
      'render',
      { jobId: renderJob._id.toString() },
      { priority: getPriority(user.role) }
    );

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

    console.log('Render job found:', job);
    console.log('Job data:', JSON.stringify(job.toObject(), null, 2));

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
