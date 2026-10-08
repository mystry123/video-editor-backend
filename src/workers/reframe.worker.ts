// src/workers/reframe.worker.ts
// AI Reframe Worker: processes reframe jobs via BullMQ
// Pattern follows transcription.worker.ts exactly

import { Job, UnrecoverableError } from 'bullmq';
import { isFinalAttempt } from '../utils/jobs';
import { File } from '../models/File';
import { Transcription } from '../models/Transcription';
import {
  analyzeVideoForReframe,
  smoothDetections,
  detectionsToZoneKeyframes,
  detectSourceRatio,
  fallbackLayout,
  isTimeout,
  isValidLayout,
  sampleEveryFor,
} from '../services/reframe.service';
import { createWorker, createJobLogger } from '../utils/worker.utils';
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
    const sourceRatio = detectSourceRatio(fileWidth, fileHeight);

    await job.updateProgress(15);

    // ── Step 4: Call YOLO + Bedrock microservice ───────────────────────
    log.info('Calling YOLO service...');
    let analysis;
    try {
      analysis = await retryOnce(() => analyzeVideoForReframe(videoUrl, {
        sampleEveryN: sampleEveryFor(fileDuration),
        sourceRatio,
        targetRatio: aspectRatio,
        transcriptionText,
        fileDuration,
        hasAudio,
      }), log);
    } catch (error: any) {
      if (isTimeout(error)) {
        // The video is too long for the detection service; retrying won't help.
        await markReframeFailed(fileId, reframeKey, 'This video took too long to analyze. Try a shorter clip.');
        throw new UnrecoverableError(`Reframe analysis timed out: ${error.message}`);
      }
      throw error;
    }

    log.info(`Got ${analysis.detections.length} detections, layout: ${analysis.layout_decision?.layout_type || 'none'}`);
    await job.updateProgress(60);

    // ── Step 5: Smooth the bounding boxes ──────────────────────────────
    const smoothed = smoothDetections(analysis.detections, 5);
    await job.updateProgress(70);

    // ── Step 6: Generate zone keyframes ────────────────────────────────
    // A missing or invalid layout from the model falls back to following the
    // most visible person instead of failing the whole job.
    const layout = isValidLayout(analysis.layout_decision) ? analysis.layout_decision : fallbackLayout(smoothed);
    if (layout !== analysis.layout_decision) log.warn('Layout missing or invalid; using fallback layout');

    const zoneKeyframes = detectionsToZoneKeyframes(
      smoothed,
      layout,
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
            layoutDecision: layout,
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
      layoutType: layout.layout_type,
      zoneCount: zoneKeyframes.length,
      reasoning: layout.reasoning,
      elementId, // returned so frontend knows which element to update
    };
  } catch (error: any) {
    log.error(`Failed (attempt ${job.attemptsMade + 1}): ${error.message}`);
    // Earlier attempts stay "processing" so the queue's retry can succeed.
    if (isFinalAttempt(job) && !(error instanceof UnrecoverableError)) await markReframeFailed(fileId, reframeKey);
    throw error;
  }
}

const REFRAME_FAILED_MESSAGE = "We couldn't analyze this video for reframing. Try again.";

/** One quick retry for blips (the queue retries the job too); never for timeouts. */
async function retryOnce<T>(fn: () => Promise<T>, log: ReturnType<typeof createJobLogger>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (isTimeout(error)) throw error;
    log.warn(`YOLO call failed, retrying once: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return fn();
  }
}

/** Marks one aspect ratio's reframe failed, unless it already finished. */
async function markReframeFailed(fileId: string, reframeKey: string, message = REFRAME_FAILED_MESSAGE): Promise<void> {
  await File.updateOne(
    { _id: fileId, [`reframe.${reframeKey}.status`]: { $nin: ['completed'] } },
    {
      $set: {
        [`reframe.${reframeKey}.status`]: 'failed',
        [`reframe.${reframeKey}.error`]: message,
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
