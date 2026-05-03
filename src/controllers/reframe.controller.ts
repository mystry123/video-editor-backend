// src/controllers/reframe.controller.ts
// Handles reframe API requests — follows transcription.controller.ts pattern

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { reframeQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

const VALID_RATIOS = ['9:16', '1:1', '4:5', '16:9'];

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

    // Check if already processed for this ratio
    const reframeKey = aspectRatio.replace(':', '_');
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

    if (existing?.status === 'processing') {
      res.status(200).json({
        status: 'processing',
        message: 'Reframe job already in progress',
      });
      return;
    }

    // Enqueue job
    const job = await reframeQueue.add('reframe', {
      fileId: fileId.toString(),
      videoUrl: file.cdnUrl,
      aspectRatio,
      elementId,
      userId: userId.toString(),
    });

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

    res.json({
      status: reframeData.status,
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
