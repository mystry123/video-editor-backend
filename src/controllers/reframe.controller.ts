// src/controllers/reframe.controller.ts
import { enqueueJob } from '../utils/jobs';
// Handles reframe API requests — follows transcription.controller.ts pattern

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { reframeQueue } from '../queues';
import { getEffectiveQuota } from '../config/quotas';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { Transcription } from '../models/Transcription';
import { getAnalysis, outputHeightFor, planAnalysis, REFRAME_CAPTIONS, reframeEngineConfigured } from '../services/reframeEngine.service';
import type { ReframeCaptions } from '../services/reframeEngine.service';

const VALID_RATIOS = ['9:16', '1:1', '4:5', '16:9', '2:3'];
const ZOOMS = ['sharp', 'balanced', 'tight'] as const;

function sameOptions(a: any, b: { zoom: string; keepText: string[]; captions: string }): boolean {
  return a?.zoom === b.zoom && (a?.captions || 'keep') === b.captions
    && JSON.stringify([...(a?.keepText || [])].sort()) === JSON.stringify([...b.keepText].sort());
}

/** The v2 fields the editor needs from a stored reframe. */
function v2Response(data: any) {
  return {
    engine: 'v2',
    result: data.result || null,
    text: data.text || [],
    pictureCaptions: Boolean(data.pictureCaptions),
    options: data.options || null,
    quality: data.quality || null,
  };
}

/**
 * POST /api/v1/reframe
 * Start a reframe job for a video file
 */
export const createReframe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { fileId, aspectRatio, elementId } = req.body;
    const zoom: string = ZOOMS.includes(req.body.zoom) ? req.body.zoom : 'balanced';
    const keepText: string[] = Array.isArray(req.body.keepText)
      ? req.body.keepText.filter((t: unknown) => typeof t === 'string').slice(0, 10)
      : [];
    const captions: ReframeCaptions = REFRAME_CAPTIONS.includes(req.body.captions) ? req.body.captions : 'keep';

    if (!fileId || !aspectRatio || !elementId) {
      throw ApiError.badRequest('fileId, aspectRatio, and elementId are required');
    }

    if (!VALID_RATIOS.includes(aspectRatio)) {
      throw ApiError.badRequest(`aspectRatio must be one of: ${VALID_RATIOS.join(', ')}`);
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: fileId, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    if (!file.mimeType?.startsWith('video/')) {
      throw ApiError.badRequest('File must be a video');
    }

    // Long videos time out in the detection service: refuse them up front.
    const maxSeconds = getEffectiveQuota(user).maxReframeSeconds;
    const duration = Number(file.metadata?.duration) || 0;
    if (maxSeconds !== -1 && duration > maxSeconds) {
      throw ApiError.withCode(
        403,
        'REFRAME_TOO_LONG',
        `AI reframe works on videos up to ${Math.round(maxSeconds / 60)} minutes. Trim this one (${Math.ceil(duration / 60)} min) and try again.`,
        { duration, limit: maxSeconds }
      );
    }

    // Check if already processed for this ratio
    const reframeKey = aspectRatio.replace(':', '_');

    if (reframeEngineConfigured()) {
      const quota = getEffectiveQuota(user);
      const quality = quota.reframeQuality || 'standard';
      const outputHeight = outputHeightFor(quota.maxResolution);
      const options = { zoom, keepText, captions };
      const current = (file as any).reframe?.get?.(reframeKey) || (file as any).reframe?.[reframeKey];

      if (current?.status === 'completed' && current.engine === 'v2' && sameOptions(current.options, options) && current.quality === quality) {
        res.status(200).json({ status: 'already_done', ...v2Response(current), message: 'Reframe already processed for this ratio' });
        return;
      }
      if (current?.status === 'processing' || current?.status === 'pending') {
        res.status(200).json({ status: 'processing', message: 'Reframe job already in progress' });
        return;
      }

      // A finished analysis of this file (same quality, same transcript) only
      // needs planning: new shapes and options come back in milliseconds.
      const transcriptAt = (await Transcription.findOne({ fileId, status: 'completed' }).select('updatedAt').lean())?.updatedAt ?? null;
      const analysis = (file as any).reframeAnalysis;
      const sameTranscript = String(analysis?.transcriptAt ?? null) === String(transcriptAt ?? null);
      if (analysis?.id && analysis.quality === quality && sameTranscript) {
        try {
          const [result, status] = await Promise.all([
            planAnalysis(analysis.id, { ratio: aspectRatio, zoom: options.zoom as any, keepText, outputHeight, captions }),
            getAnalysis(analysis.id),
          ]);
          const blob = { status: 'completed', engine: 'v2', analysisId: analysis.id, quality, options, result,
                         text: status.text || [], pictureCaptions: Boolean(status.pictureCaptions),
                         progress: 1, processedAt: new Date() };
          await File.updateOne({ _id: fileId }, { $set: { [`reframe.${reframeKey}`]: blob } });
          res.status(200).json({ status: 'already_done', ...v2Response(blob), message: 'Reframed from the existing analysis' });
          return;
        } catch (error: any) {
          // Expired or unknown analysis: analyse again below. Anything else
          // (service down, timeout) would fail the new analysis too.
          const status = error?.response?.status;
          if (status !== 404 && status !== 409) throw error;
          logger.info('[reframe] Reusing analysis failed; analysing again', { fileId, error: error?.message });
        }
      }

      await File.updateOne(
        { _id: fileId },
        { $set: { [`reframe.${reframeKey}`]: { status: 'pending', engine: 'v2', options, quality, stage: 'Waiting to start', progress: 0 } } }
      );
      let queued: { id: string };
      try {
        queued = await enqueueJob(
          reframeQueue,
          'reframe',
          { fileId: fileId.toString(), videoUrl: file.cdnUrl, aspectRatio, elementId, userId: userId.toString(),
            engine: 'v2', quality, outputHeight, zoom, keepText, captions },
          { jobId: `reframe-${fileId}-${reframeKey}` }
        );
      } catch (error) {
        await File.updateOne(
          { _id: fileId },
          { $set: { [`reframe.${reframeKey}.status`]: 'failed', [`reframe.${reframeKey}.error`]: 'Reframe is temporarily unavailable. Try again in a minute.' } }
        );
        throw error;
      }
      res.status(201).json({ status: 'queued', jobId: queued.id, message: 'Reframe job queued' });
      return;
    }
    const existing = (file as any).reframe?.get?.(reframeKey) || (file as any).reframe?.[reframeKey];

    if (existing?.status === 'completed') {
      res.status(200).json({
        status: 'already_done',
        layoutDecision: existing.layoutDecision,
        zones: existing.zones,
        message: 'Reframe already processed for this ratio',
      });
      return;
    }

    if (existing?.status === 'processing' || existing?.status === 'pending') {
      res.status(200).json({
        status: 'processing',
        message: 'Reframe job already in progress',
      });
      return;
    }

    // Mark it pending right away (clearing any earlier failure), so the first
    // status poll doesn't read a stale "failed" while the job waits in the queue.
    await File.updateOne(
      { _id: fileId },
      { $set: { [`reframe.${reframeKey}.status`]: 'pending' }, $unset: { [`reframe.${reframeKey}.error`]: '' } }
    );

    // One job per file + ratio: repeated clicks don't queue duplicate analyses.
    let job: { id: string };
    try {
      job = await enqueueJob(
        reframeQueue,
        'reframe',
        { fileId: fileId.toString(), videoUrl: file.cdnUrl, aspectRatio, elementId, userId: userId.toString() },
        { jobId: `reframe-${fileId}-${reframeKey}` }
      );
    } catch (error) {
      await File.updateOne(
        { _id: fileId },
        { $set: { [`reframe.${reframeKey}.status`]: 'failed', [`reframe.${reframeKey}.error`]: 'Reframe is temporarily unavailable. Try again in a minute.' } }
      );
      throw error;
    }

    logger.info(`[reframe] Queued job ${job.id} for file ${fileId} → ${aspectRatio}`);

    res.status(201).json({
      status: 'queued',
      jobId: job.id,
      message: 'Reframe job queued',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/reframe/status/:fileId/:aspectRatio
 * Poll reframe job status
 */
export const getReframeStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { fileId, aspectRatio } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: fileId, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    const reframeKey = aspectRatio.replace(':', '_');
    const reframeData = (file as any).reframe?.get?.(reframeKey) || (file as any).reframe?.[reframeKey];

    if (!reframeData) {
      res.json({ status: 'not_started' });
      return;
    }

    if (reframeData.engine === 'v2') {
      res.json({
        status: reframeData.status === 'pending' ? 'queued' : reframeData.status,
        stage: reframeData.stage || null,
        progress: reframeData.progress ?? null,
        error: reframeData.error || null,
        processedAt: reframeData.processedAt || null,
        ...v2Response(reframeData),
      });
      return;
    }

    res.json({
      // "pending" (set when the job is queued) is what the editor calls "queued".
      status: reframeData.status === 'pending' ? 'queued' : reframeData.status,
      layoutDecision: reframeData.layoutDecision || null,
      zones: reframeData.zones || null,
      sceneStats: reframeData.sceneStats || null,
      error: reframeData.error || null,
      processedAt: reframeData.processedAt || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/reframe/:fileId/:aspectRatio
 * Clear reframe data for a specific ratio
 */
export const deleteReframe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { fileId, aspectRatio } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const reframeKey = aspectRatio.replace(':', '_');

    await File.updateOne(
      { _id: fileId, userId: user._id },
      { $unset: { [`reframe.${reframeKey}`]: 1 } }
    );

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
