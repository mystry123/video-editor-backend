// src/workers/reframe.worker.ts
// AI Reframe Worker: processes reframe jobs via BullMQ
// Pattern follows transcription.worker.ts exactly

import { Job } from 'bullmq';
import { isFinalAttempt } from '../utils/jobs';
import { File } from '../models/File';
import { Transcription } from '../models/Transcription';
import {
  analyzeVideoForReframe,
  smoothDetections,
  detectionsToZoneKeyframes,
} from '../services/reframe.service';
import { createWorker, createJobLogger, retryWithBackoff } from '../utils/worker.utils';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

interface ReframeJobData {
  fileId: string;
  videoUrl: string;
  aspectRatio: '9:16' | '1:1' | '4:5' | '16:9';
  elementId: string;    // frontend element ID to update
  userId: string;
}

// ============================================================================
// Processor
// ============================================================================

async function processReframeJob(job: Job<ReframeJobData>) {
  const { fileId, videoUrl, aspectRatio, elementId, userId } = job.data;
  const log = createJobLogger('Reframe', fileId);

  log.info(`Processing reframe to ${aspectRatio}`);

  const reframeKey = aspectRatio.replace(':', '_'); // "9_16"

  try {
    // ── Step 1: Mark as processing ─────────────────────────────────────
    await File.updateOne(
      { _id: fileId },
      { $set: { [`reframe.${reframeKey}.status`]: 'processing' } }
    );
    await job.updateProgress(5);

    // ── Step 2: Get transcription text for scene context (if available) ─
    let transcriptionText: string | undefined;
    try {
      const transcription = await Transcription.findOne({ fileId }).lean();
      if (transcription && transcription.text) {
        transcriptionText = transcription.text;
        log.info('Found transcription for scene context');
      } else {
        log.info('No transcription found — using YOLO + metadata only');
      }
    } catch (err: any) {
      log.warn(`Transcription lookup failed: ${err.message}`);
    }
    await job.updateProgress(10);

    // ── Step 3: Get file metadata ──────────────────────────────────────
    const file = await File.findById(fileId).lean();
    if (!file) {
      throw new Error('File not found');
    }

    const fileDuration = file.metadata?.duration;
    const hasAudio = file.metadata?.hasAudio ?? true;

    // Determine source ratio from file dimensions
    const fileWidth = file.metadata?.width || 1920;
    const fileHeight = file.metadata?.height || 1080;
    const sourceAr = fileWidth / fileHeight;
    let sourceRatio = '16:9';
    if (Math.abs(sourceAr - 1) < 0.1) sourceRatio = '1:1';
    else if (sourceAr < 1) sourceRatio = '9:16';
    else if (Math.abs(sourceAr - 4 / 5) < 0.1) sourceRatio = '4:5';

    await job.updateProgress(15);

    // ── Step 4: Call YOLO + Bedrock microservice ───────────────────────
    log.info('Calling YOLO service...');
    const analysis = await retryWithBackoff(
      () => analyzeVideoForReframe(videoUrl, {
        sampleEveryN: 3,
        sourceRatio,
        targetRatio: aspectRatio,
        transcriptionText,
        fileDuration,
        hasAudio,
      }),
      {
        maxRetries: 2,
        initialDelay: 3000,
        maxDelay: 15000,
        onRetry: (err, attempt) => log.warn(`YOLO retry ${attempt}: ${err.message}`),
      }
    );

    log.info(`Got ${analysis.detections.length} detections, layout: ${analysis.layout_decision?.layout_type || 'none'}`);
    await job.updateProgress(60);

    // ── Step 5: Smooth the bounding boxes ──────────────────────────────
    const smoothed = smoothDetections(analysis.detections, 5);
    await job.updateProgress(70);

    // ── Step 6: Generate zone keyframes ────────────────────────────────
    if (!analysis.layout_decision) {
      throw new Error('No layout decision returned from YOLO service');
    }

    const zoneKeyframes = detectionsToZoneKeyframes(
      smoothed,
      analysis.layout_decision,
      aspectRatio,
      analysis.video_width,
      analysis.video_height
    );
    await job.updateProgress(85);

    // ── Step 7: Save result to File model ──────────────────────────────
    await File.updateOne(
      { _id: fileId },
      {
        $set: {
          [`reframe.${reframeKey}`]: {
            status: 'completed',
            layoutDecision: analysis.layout_decision,
            zones: zoneKeyframes,
            sceneStats: analysis.scene_stats,
            fps: analysis.fps,
            videoWidth: analysis.video_width,
            videoHeight: analysis.video_height,
            processedAt: new Date(),
          },
        },
      }
    );

    await job.updateProgress(100);
    log.info(`Reframe complete: ${zoneKeyframes.length} zones, ${zoneKeyframes.reduce((sum, z) => sum + z.keyframes.length, 0)} total keyframes`);

    return {
      success: true,
      layoutType: analysis.layout_decision.layout_type,
      zoneCount: zoneKeyframes.length,
      reasoning: analysis.layout_decision.reasoning,
      elementId, // returned so frontend knows which element to update
    };
  } catch (error: any) {
    log.error(`Failed (attempt ${job.attemptsMade + 1}): ${error.message}`);
    // Earlier attempts stay "processing" so the queue's retry can succeed.
    if (isFinalAttempt(job)) await markReframeFailed(fileId, reframeKey);
    throw error;
  }
}

const REFRAME_FAILED_MESSAGE = "We couldn't analyze this video for reframing. Try again.";

/** Marks one aspect ratio's reframe failed, unless it already finished. */
async function markReframeFailed(fileId: string, reframeKey: string): Promise<void> {
  await File.updateOne(
    { _id: fileId, [`reframe.${reframeKey}.status`]: { $nin: ['completed'] } },
    {
      $set: {
        [`reframe.${reframeKey}.status`]: 'failed',
        [`reframe.${reframeKey}.error`]: REFRAME_FAILED_MESSAGE,
      },
    }
  );
}

// ============================================================================
// Create Worker
// ============================================================================

const reframeWorker = createWorker({
  name: 'reframe',
  processor: processReframeJob,
  // Crashed or stalled for good: don't leave the reframe "processing".
  onFinalFailure: async (job) => markReframeFailed(job.data.fileId, job.data.aspectRatio.replace(':', '_')),
  concurrency: 2,
  lockDuration: 600_000, // 10 minutes for long videos
});

export default reframeWorker;
