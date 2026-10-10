import { Response, NextFunction } from 'express';
import { enqueueJob, transition } from '../utils/jobs';
import { RenderJob } from '../models/RenderJob';
import { releaseUsage } from '../services/usage.service';
import { ApiError } from '../utils/ApiError';
import { Types } from 'mongoose';
import { ACTIVE_CAPTION_STATES, CaptionProject, CaptionProjectStatus } from '../models/Caption';
import { CaptionPreset } from '../models/CaptionPreset';
import { File } from '../models/File';
import { Transcription } from '../models/Transcription';
import { canTranscribe } from '../utils/checkAudioStream';
import { logger } from '../utils/logger';

// Import queue getter - lazy initialization
import { env } from '../config/env';
import { captionProjectSettingsSchema, fontUrlOnCdn } from '../schemas/captionStyle';
import { recordPresetUse } from '../services/captionPresetUsage.service';

let _captionQueue: any = null;
async function getCaptionQueue() {
  if (!_captionQueue) {
    // Dynamic import to avoid circular dependency and connection on load
    const queues = await import('../queues');
    _captionQueue = queues.getCaptionQueue ? queues.getCaptionQueue() : queues.captionQueue;
  }
  return _captionQueue;
}

// ============================================================================
// Types
// ============================================================================

/** Presets a user may apply: built-in, shared publicly, or their own. */
function usablePresetFilter(presetId: string, userId: string | undefined) {
  return {
    _id: presetId,
    $or: [{ isSystem: true }, { isPublic: true }, ...(userId ? [{ userId }] : [])],
  };
}

interface AuthRequest {
  userId?: string;
  body: any;
  params: any;
  query: any;
}


// ============================================================================
// Status Response Builder
// ============================================================================

interface StageStatus {
  status: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed';
  progress: number;
}

interface StatusResponse {
  id: string;
  status: CaptionProjectStatus;
  progress: number;
  stages: {
    transcription: StageStatus;
    generation: StageStatus;
    rendering: StageStatus;
  };
  message: string;
  startedAt?: Date;
  completedAt?: Date;
  outputUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

function buildStatusResponse(project: any, renderProgress?: number): StatusResponse {
  const status = project.status;
  let overallProgress = 0;
  let message = '';
  
  // Stage statuses
  const stages = {
    transcription: { status: 'pending' as StageStatus['status'], progress: 0 },
    generation: { status: 'pending' as StageStatus['status'], progress: 0 },
    rendering: { status: 'pending' as StageStatus['status'], progress: 0 },
  };
  
  switch (status) {
    case 'pending':
      overallProgress = 0;
      message = 'Waiting to start...';
      break;
      
    case 'transcribing':
      stages.transcription.status = 'processing';
      stages.transcription.progress = project.progress || 50;
      overallProgress = Math.round(stages.transcription.progress * 0.4); // 0-40%
      message = 'Transcribing audio...';
      break;
      
    case 'generating':
      stages.transcription.status = 'completed';
      stages.transcription.progress = 100;
      stages.generation.status = 'processing';
      stages.generation.progress = project.progress || 50;
      overallProgress = 40 + Math.round(stages.generation.progress * 0.1); // 40-50%
      message = 'Generating captions...';
      break;
      
    case 'rendering':
      stages.transcription.status = 'completed';
      stages.transcription.progress = 100;
      stages.generation.status = 'completed';
      stages.generation.progress = 100;
      stages.rendering.status = 'processing';
      stages.rendering.progress = renderProgress ?? project.progress ?? 0;
      overallProgress = 50 + Math.round(stages.rendering.progress * 0.45); // 50-95%
      message = stages.rendering.progress < 90 ? 'Rendering video...' : 'Encoding video...';
      break;
      
    case 'completed':
      stages.transcription.status = project.transcriptionId ? 'completed' : 'skipped';
      stages.transcription.progress = 100;
      stages.generation.status = 'completed';
      stages.generation.progress = 100;
      stages.rendering.status = 'completed';
      stages.rendering.progress = 100;
      overallProgress = 100;
      message = 'Complete!';
      break;
      
    case 'failed':
      overallProgress = project.progress || 0;
      message = project.error || 'An error occurred';
      
      // Mark the failed stage
      if (overallProgress < 40) {
        stages.transcription.status = 'failed';
      } else if (overallProgress < 50) {
        stages.transcription.status = 'completed';
        stages.transcription.progress = 100;
        stages.generation.status = 'failed';
      } else {
        stages.transcription.status = 'completed';
        stages.transcription.progress = 100;
        stages.generation.status = 'completed';
        stages.generation.progress = 100;
        stages.rendering.status = 'failed';
      }
      break;
  }
  
  return {
    id: project._id.toString(),
    status,
    progress: overallProgress,
    stages,
    message,
    startedAt: project.createdAt,
    completedAt: project.renderCompletedAt,
    outputUrl: project.outputUrl,
    thumbnailUrl: project.thumbnailUrl,
    error: project.error,
  };
}

// ============================================================================
// Controller
// ============================================================================

export class CaptionProjectController {
  
  /**
   * POST /api/caption-projects
   * 
   * Create a new caption project and start processing
   */
  static async create(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { fileId, presetId, name } = req.body;

      // Settings (incl. the editor's full caption style and position) are
      // validated: they're rendered as sent
      const parsedSettings = captionProjectSettingsSchema.safeParse(req.body.setting ?? {});
      if (!parsedSettings.success) {
        throw ApiError.badRequest(
          'Invalid caption settings: ' +
            parsedSettings.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        );
      }
      const setting = parsedSettings.data;
      if (!fontUrlOnCdn(setting.style, env.cdnUrl)) {
        throw ApiError.badRequest('Invalid caption settings: style.fontUrl: must be a font you uploaded');
      }


      // Validate fileId
      if (!fileId) {
        throw ApiError.badRequest('fileId is required');
      }
      
      if (!Types.ObjectId.isValid(fileId)) {
        throw ApiError.badRequest('Invalid fileId format');
      }
      
      // Verify file exists and belongs to user
      const file = await File.findOne({ _id: fileId, userId });
      if (!file) {
        throw ApiError.notFound('File not found');
      }
      
      // Verify file is video/audio
      if (!file.mimeType.startsWith('video/') && !file.mimeType.startsWith('audio/')) {
        throw ApiError.badRequest('File must be video or audio');
      }
      
      // Verify file is ready
      if (file.status !== 'ready') {
        throw ApiError.badRequest(`File is not ready. Status: ${file.status}`);
      }

      const validation = await canTranscribe(file.cdnUrl);

      logger.info(`Validation result: ${JSON.stringify(validation)}`);
    
      if (!validation.canTranscribe) {
        throw ApiError.badRequest(validation.reason || 'File cannot be transcribed');
      }
    
      
      // Validate presetId if provided
      if (presetId) {
        if (!Types.ObjectId.isValid(presetId)) {
          throw ApiError.badRequest('Invalid presetId format');
        }
        
        const preset = await CaptionPreset.findOne(usablePresetFilter(presetId, userId));
        if (!preset) {
          throw ApiError.notFound('Preset not found');
        }
      }
      
      // Check if there's already an existing transcription for this file
      const existingTranscription = await Transcription.findOne({ 
        fileId, 
        status: 'completed' 
      });
      
      // Create the caption project
      const project = await CaptionProject.create({
        userId,
        fileId,
        presetId,
        transcriptionId: existingTranscription?._id,
        settings:setting,
        name: name || file.originalName || 'Captioned Video',
        status: 'pending',
        progress: 0,
      });

      // One use of the style for this project (renders don't count again)
      if (presetId) await recordPresetUse(presetId, userId, `caption-project:${project._id}`);
      
      // Add to processing queue
      const queue = await getCaptionQueue();
      try {
        await enqueueJob(
          queue,
          'process-caption',
          { projectId: project._id.toString(), hasExistingTranscription: !!existingTranscription },
          { jobId: `caption-${project._id}`, removeOnComplete: true, removeOnFail: false }
        );
      } catch (error) {
        await CaptionProject.updateOne(
          { _id: project._id },
          { status: 'failed', error: 'Captioning is temporarily unavailable. Try again in a minute.' }
        );
        throw error;
      }
      
      res.status(201).json({
        success: true,
        data: {
          id: project._id,
          status: project.status,
          message: existingTranscription 
            ? 'Using existing transcription, generating captions...'
            : 'Starting transcription...',
        },
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * GET /api/caption-projects/:id/status
   * 
   * Get project status for polling
   */
  static async getStatus(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      
      if (!Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid project ID');
      }
      
      const project = await CaptionProject.findOne({ _id: id, userId });
      if (!project) {
        throw ApiError.notFound('Caption project not found');
      }
      
      // If rendering, get render job progress for more accurate percentage
      let renderProgress: number | undefined;
      if (project.status === 'rendering' && project.renderJobId) {
        const RenderJob = (await import('../models/RenderJob')).RenderJob;
        const renderJob = await RenderJob.findById(project.renderJobId);
        if (renderJob) {
          renderProgress = renderJob.progress;
        }
      }
      
      const statusResponse = buildStatusResponse(project, renderProgress);
      
      res.json({
        success: true,
        data: statusResponse,
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * GET /api/caption-projects/:id
   * 
   * Get full project details
   */
  static async getOne(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      
      if (!Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid project ID');
      }
      
      const project = await CaptionProject.findOne({ _id: id, userId })
        .populate('fileId', 'name originalName cdnUrl mimeType metadata')
        .populate('presetId', 'name category styles')
        .populate('transcriptionId', 'status text words');
      
      if (!project) {
        throw ApiError.notFound('Caption project not found');
      }
      
      res.json({
        success: true,
        data: project,
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * GET /api/caption-projects
   * 
   * List user's caption projects
   */
  static async list(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { status, page = '1', limit = '20' } = req.query;
      
      const query: any = { userId };
      if (status) {
        query.status = status;
      }
      
      const pageNum = parseInt(page as string);
      const limitNum = Math.min(parseInt(limit as string), 100);
      const skip = (pageNum - 1) * limitNum;
      
      const [projects, total] = await Promise.all([
        CaptionProject.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .populate('fileId', 'name originalName thumbnailUrl')
          .populate('presetId', 'name category')
          .lean(),
        CaptionProject.countDocuments(query),
      ]);
      
      res.json({
        success: true,
        data: projects,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * POST /api/caption-projects/:id/cancel
   * 
   * Cancel a project in progress
   */
  static async cancel(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      
      if (!Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid project ID');
      }
      
      // Conditional: a project that just completed (or was cancelled) stays as it is.
      const project = await CaptionProject.findOneAndUpdate(
        { _id: id, userId, status: { $in: ACTIVE_CAPTION_STATES } },
        { $set: { status: 'failed', error: 'Cancelled by user', cancelledAt: new Date() } },
        { new: false }
      );
      if (!project) {
        throw ApiError.notFound('Project not found or cannot be cancelled');
      }

      // Stop its render (refunded, and a late finish deletes the file).
      if (project.renderJobId) {
        await transition(RenderJob, project.renderJobId, ['pending', 'queued', 'rendering'], {
          status: 'cancelled',
          completedAt: new Date(),
        });
      }
      await releaseUsage('captionRenderMinutes', `caption-render-${id}`, 'cancelled');
      await releaseUsage('captionExports', `caption-export-${id}`, 'cancelled');

      // Remove the pipeline job if it hasn't started (its id is caption-<projectId>).
      try {
        const job = await (await getCaptionQueue()).getJob(`caption-${id}`);
        if (job && (await job.getState()) !== 'active') await job.remove();
      } catch {
        // Not in the queue (or running): the worker sees the cancelled status.
      }

      res.json({
        success: true,
        message: 'Project cancelled',
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * DELETE /api/caption-projects/:id
   * 
   * Delete a project
   */
  static async delete(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      
      if (!Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid project ID');
      }
      
      const project = await CaptionProject.findOne({ _id: id, userId });
      if (!project) {
        throw ApiError.notFound('Caption project not found');
      }
      
      // Don't delete if currently processing (must cancel first)
      if (['transcribing', 'generating', 'rendering'].includes(project.status)) {
        throw ApiError.badRequest('Cannot delete project in progress. Cancel it first.');
      }
      
      await CaptionProject.deleteOne({ _id: id });
      
      // Note: templateId is not part of CaptionProject schema
      // If templates need cleanup, it should be handled separately
      
      res.json({
        success: true,
        message: 'Project deleted',
      });
      
    } catch (error: any) {
      next(error);
    }
  }
  
  /**
   * PATCH /api/caption-projects/:id/preset
   * 
   * Update preset and regenerate (only if not yet rendering)
   */
  static async updatePreset(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { presetId } = req.body;
      
      if (!Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid project ID');
      }
      
      if (!presetId || !Types.ObjectId.isValid(presetId)) {
        throw ApiError.badRequest('Valid presetId is required');
      }
      
      const project = await CaptionProject.findOne({ _id: id, userId });
      if (!project) {
        throw ApiError.notFound('Caption project not found');
      }
      
      // Can only update preset if not yet rendering or completed
      if (['rendering', 'completed'].includes(project.status)) {
        throw ApiError.badRequest('Cannot change preset after rendering has started');
      }
      
      // Verify preset exists
      const preset = await CaptionPreset.findOne(usablePresetFilter(presetId, userId));
      if (!preset) {
        throw ApiError.notFound('Preset not found');
      }
      
      // Only while not rendering yet; the stored composition is for the old
      // preset, so it's dropped and generated again.
      const updated = await CaptionProject.updateOne(
        { _id: id, status: { $nin: ['rendering', 'completed'] } },
        { $set: { presetId }, $unset: { composition: '' } }
      );
      if (updated.modifiedCount === 0) {
        throw ApiError.badRequest('The preset can no longer be changed: rendering has started.');
      }
      
      res.json({
        success: true,
        message: 'Preset updated',
      });
      
    } catch (error: any) {
      next(error);
    }
  }
}