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
import {
  getAnalysis,
  planAnalysis,
  reframeEngineConfigured,
  submitAnalysis,
  type ReframeQuality,
  type ReframeZoom,
} from '../services/reframeEngine.service';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

interface ReframeJobData {
  fileId: string;
  videoUrl: string;
  aspectRatio: '9:16' | '1:1' | '4:5' | '16:9' | '2:3';
  elementId: string;    // frontend element ID to update
  userId: string;
  // Engine v2 (reframe service) only:
  engine?: 'v2';
  quality?: ReframeQuality;
  outputHeight?: number;
  zoom?: ReframeZoom;
  keepText?: string[];
}

// ============================================================================
// Engine v2: the reframe service
// ============================================================================

const POLL_MS = 2000;
const MAX_POLL_ERRORS = 10;

async function processReframeV2(job: Job<ReframeJobData>) {
  const { fileId, videoUrl, aspectRatio } = job.data;
  const key = aspectRatio.replace(':', '_');
  const log = createJobLogger('Reframe v2', fileId);
  const quality = job.data.quality || 'standard';

  // The transcript (when there is one) lets the engine follow whoever speaks.
  const transcription = await Transcription.findOne({ fileId, status: 'completed' }).select('words updatedAt').lean();
  const words = transcription?.words?.map((w) => ({ text: w.text, start: w.start, end: w.end, type: w.type, speaker_id: w.speaker_id }));

  const submitted = await submitAnalysis({ videoUrl, words, quality });
  log.info(`Analysis ${submitted.id} (${submitted.status})`);
  await File.updateOne(
    { _id: fileId },
    { $set: { [`reframe.${key}.status`]: 'processing', [`reframe.${key}.engine`]: 'v2', [`reframe.${key}.analysisId`]: submitted.id } }
  );

  // Wait for the analysis, reporting its stage. Long videos take a while, but
  // never longer than this.
  const deadline = Date.now() + 45 * 60_000;
  let status = submitted;
  let errors = 0;
  let lastStage = '';
  while (status.status !== 'done') {
    if (status.status === 'failed') {
      throw new UnrecoverableError(status.error || 'The video could not be analysed.');
    }
    if (Date.now() > deadline) throw new UnrecoverableError('Analysis took too long.');
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      status = await getAnalysis(submitted.id);
      errors = 0;
    } catch (error: any) {
      if (++errors >= MAX_POLL_ERRORS) throw error; // service unreachable: let the queue retry
      continue;
    }
    const progress = Math.round((status.progress || 0) * 100);
    if (status.stageLabel && (status.stageLabel !== lastStage || progress % 10 === 0)) {
      lastStage = status.stageLabel;
      await File.updateOne(
        { _id: fileId, [`reframe.${key}.status`]: 'processing' },
        { $set: { [`reframe.${key}.stage`]: status.stageLabel, [`reframe.${key}.progress`]: status.progress || 0 } }
      );
      await job.updateProgress(progress);
    }
  }

  const options = { zoom: job.data.zoom || 'balanced', keepText: job.data.keepText || [] };
  const result = await planAnalysis(submitted.id, {
    ratio: aspectRatio, zoom: options.zoom, keepText: options.keepText, outputHeight: job.data.outputHeight || 1080,
  });
  await File.updateOne(
    { _id: fileId },
    {
      $set: {
        [`reframe.${key}`]: {
          status: 'completed', engine: 'v2', analysisId: submitted.id, quality, options, result,
          text: status.text || [], progress: 1, processedAt: new Date(),
        },
        reframeAnalysis: { id: submitted.id, quality, transcriptAt: transcription?.updatedAt ?? null },
      },
    }
  );
  log.info(`Done: ${(result as any).segments?.length ?? 0} segments`);
  return { success: true, engine: 'v2', analysisId: submitted.id };
}

// ============================================================================
// Processor
// ============================================================================

async function processReframeJob(job: Job<ReframeJobData>) {
  if (job.data.engine === 'v2' && reframeEngineConfigured()) {
    try {
      return await processReframeV2(job);
    } catch (error: any) {
      const key = job.data.aspectRatio.replace(':', '_');
      if (error instanceof UnrecoverableError) {
        await markReframeFailed(job.data.fileId, key, error.message);
      } else if (isFinalAttempt(job)) {
        await markReframeFailed(job.data.fileId, key);
      }
      throw error;
    }
  }
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
