// workers/render.worker.ts
//
// Renders a video here, on the worker (see services/render.service.ts):
// claim the job, render to a temp file while saving progress, upload it to the
// renders bucket, then complete it through the lifecycle service, which
// charges, notifies and makes the link. Cancelling the job (or passing the
// deadline) stops the render within a few seconds.

import fs from 'fs/promises';
import os from 'os';
import { Job } from 'bullmq';
import { RenderJob } from '../models/RenderJob';
import {
  closeBrowser,
  isBrowserCrash,
  localOutputPath,
  makeCancelSignal,
  renderVideo,
  resolveServeUrl,
  uploadRenderOutput,
} from '../services/render.service';
import {
  RENDER_DEADLINE_MS,
  RENDER_TIMEOUT_MESSAGE,
  completeRender,
  describeRenderError,
  failRender,
} from '../services/renderLifecycle.service';
import { createWorker, createJobLogger } from '../utils/worker.utils';
import { env } from '../config/env';

interface RenderJobData {
  jobId: string;
}

/** How often progress is saved, cancel/deadline are checked, and the deadline (tests shorten them) */
export const renderTimings = { progressEveryMs: 2000, watchEveryMs: 5000, deadlineMs: RENDER_DEADLINE_MS };

export async function processRenderJob(job: Job<RenderJobData>) {
  const { jobId } = job.data;
  const log = createJobLogger('Render', jobId);

  // Claim it. "rendering" means an earlier run of this job died mid-render
  // (BullMQ only re-runs a job after its worker lost it): start it over.
  const renderId = `local-${os.hostname()}-${Date.now()}`;
  const claimed = await RenderJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ['pending', 'queued', 'rendering'] } },
    { status: 'rendering', startedAt: new Date(), renderId, progress: 0, lastProgressAt: new Date() },
    { new: true, select: '+inputProps +webhookUrl' }
  );
  if (!claimed) {
    const existing = await RenderJob.findById(jobId).select('status').lean();
    log.info(`Not rendering: ${existing?.status ?? 'not found'}`);
    return { skipped: true, reason: existing?.status ?? 'not_found' };
  }

  const startedAt = Date.now();
  const outputPath = localOutputPath(jobId, claimed.outputFormat);
  const { cancelSignal, cancel } = makeCancelSignal();
  const stop: { reason: 'cancelled' | 'deadline' | null } = { reason: null };

  // Save progress at most every progressEveryMs (never 100: that's "done").
  let lastSaved = 0;
  const saveProgress = (fields: Record<string, unknown>) =>
    RenderJob.updateOne({ _id: jobId, status: 'rendering' }, { ...fields, lastProgressAt: new Date() }).catch((err) =>
      log.warn(`Progress save failed: ${err.message}`)
    );

  const watcher = setInterval(async () => {
    try {
      const current = await RenderJob.findById(jobId).select('status').lean();
      if (!current || current.status !== 'rendering') {
        stop.reason = 'cancelled';
        cancel();
      } else if (Date.now() - startedAt > renderTimings.deadlineMs) {
        stop.reason = 'deadline';
        cancel();
      }
    } catch (err: any) {
      log.warn(`Watch failed: ${err.message}`);
    }
  }, renderTimings.watchEveryMs);

  try {
    const serveUrl = await resolveServeUrl();
    await RenderJob.updateOne({ _id: jobId, status: 'rendering' }, { serveUrl });
    log.info(`Rendering (${claimed.outputFormat}, scale ${claimed.scale || 1}) from ${serveUrl}`);

    const result = await renderVideo({
      serveUrl,
      project: claimed.inputProps?.project,
      elements: claimed.inputProps?.elements || [],
      outputFormat: claimed.outputFormat,
      scale: claimed.scale || 1,
      outputPath,
      cancelSignal,
      onProgress: (p) => {
        if (Date.now() - lastSaved < renderTimings.progressEveryMs) return;
        lastSaved = Date.now();
        void saveProgress({
          progress: Math.min(99, Math.round(p.progress * 100)),
          framesRendered: p.renderedFrames,
          encodingStatus: { stage: p.stage, encodedFrames: p.encodedFrames },
        });
      },
    });
    clearInterval(watcher);

    await saveProgress({ progress: 99, framesRendered: result.frames, encodingStatus: { stage: 'uploading' } });
    const outputUrl = await uploadRenderOutput(outputPath, claimed);
    const timeToFinish = Date.now() - startedAt;
    const completed = await completeRender(jobId, {
      outputUrl,
      stats: { timeToFinish, outputSizeInBytes: result.sizeBytes, framesRendered: result.frames },
    });
    log.info(`${completed ? 'Completed' : 'Finished after it ended'} in ${Math.round(timeToFinish / 1000)}s (${result.frames} frames)`);
    return { completed };
  } catch (err: any) {
    clearInterval(watcher);
    if (stop.reason === 'cancelled') {
      log.info('Stopped: the job was cancelled');
      return { cancelled: true };
    }
    if (stop.reason === 'deadline') {
      await failRender(jobId, RENDER_TIMEOUT_MESSAGE, 'render_timeout');
      return { failed: 'timeout' };
    }
    log.error(`Failed: ${err.message}`);
    // A dead Chrome is shared by later renders; start a fresh one next time.
    if (isBrowserCrash(err.message)) await closeBrowser();
    // Render errors are about the project (or a broken bundle): retrying the
    // same input won't help, so fail it now instead of letting BullMQ retry.
    await failRender(jobId, describeRenderError(err.message), 'render_failed', {
      renderErrors: [{ message: String(err.message).slice(0, 2000) }],
    });
    return { failed: true };
  } finally {
    clearInterval(watcher);
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

const renderWorker = createWorker({
  name: 'render',
  processor: processRenderJob,
  // Crashed or stalled for good: don't leave the render "rendering" forever.
  onFinalFailure: async (job) => {
    await failRender(job.data.jobId, 'The render stopped unexpectedly. Try again.', 'render_crashed');
  },
  // A render uses every core it gets; run them one (or a few) at a time.
  concurrency: env.renderConcurrency,
  lockDuration: 180000,
});

export default renderWorker;
