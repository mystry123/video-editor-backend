// workers/render.worker.ts
//
// RENDER_PROVIDER=lambda: starts the render on Remotion Lambda
// (services/lambdaRender.service.ts), then either returns (webhook mode:
// Remotion calls us when it ends) or polls Lambda until it ends.
//
// RENDER_PROVIDER=local (default): renders the video here, on the worker
// (see services/render.service.ts):
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
  checkRender,
  completeRender,
  describeRenderError,
  failRender,
} from '../services/renderLifecycle.service';
import { isLambdaRenderId, startLambdaRender, webhookMode } from '../services/lambdaRender.service';
import { createWorker, createJobLogger, retryWithBackoff, sleep } from '../utils/worker.utils';
import { isFinalAttempt } from '../utils/jobs';
import { env } from '../config/env';

interface RenderJobData {
  jobId: string;
}

/** How often progress is saved, cancel/deadline are checked, and the deadline (tests shorten them) */
export const renderTimings = { progressEveryMs: 2000, watchEveryMs: 5000, deadlineMs: RENDER_DEADLINE_MS, lambdaPollEveryMs: 2000 };

export async function processRenderJob(job: Job<RenderJobData>) {
  return env.renderProvider === 'lambda' ? processLambdaRender(job) : processLocalRender(job);
}

// ============================================================================
// Remotion Lambda
// ============================================================================

/** Poll mode: wait here until Lambda reports the render ended (or the deadline passes). */
async function pollUntilDone(jobId: string, log: ReturnType<typeof createJobLogger>) {
  const deadline = Date.now() + RENDER_DEADLINE_MS + 60_000;
  while (Date.now() < deadline) {
    await sleep(renderTimings.lambdaPollEveryMs);
    const job = await RenderJob.findById(jobId).select('status renderId bucketName startedAt').lean();
    if (!job || job.status !== 'rendering') {
      log.info(`Stopped polling: ${job?.status ?? 'deleted'}`);
      return { ended: job?.status ?? 'deleted' };
    }
    try {
      const outcome = await checkRender(job);
      if (outcome !== 'rendering') {
        log.info(`Render ${outcome}`);
        return { ended: outcome };
      }
    } catch (err: any) {
      log.warn(`Poll error: ${err.message}`);
      await sleep(renderTimings.lambdaPollEveryMs);
    }
  }
  await failRender(jobId, RENDER_TIMEOUT_MESSAGE, 'render_timeout');
  return { ended: 'timeout' };
}

export async function processLambdaRender(job: Job<RenderJobData>) {
  const { jobId } = job.data;
  const log = createJobLogger('Render', jobId);

  const dbJob = await RenderJob.findById(jobId).select('status renderId bucketName startedAt');
  if (!dbJob) {
    log.warn('Not found');
    return { skipped: true, reason: 'not_found' };
  }
  if (['completed', 'failed', 'cancelled'].includes(dbJob.status)) {
    return { skipped: true, reason: dbJob.status };
  }

  // Already started on Lambda (a resumed job): check on it instead of starting again.
  if (dbJob.status === 'rendering' && isLambdaRenderId(dbJob.renderId) && dbJob.bucketName) {
    log.info(`Resuming: ${dbJob.renderId}`);
    if (webhookMode()) return { checked: await checkRender(dbJob) };
    return await pollUntilDone(jobId, log);
  }

  // Claim it. "rendering" without a Lambda renderId means an earlier attempt
  // died while starting the render (or it was rendering locally before a
  // provider switch): take it over instead of leaving it stuck.
  const claimed = await RenderJob.findOneAndUpdate(
    {
      _id: jobId,
      $or: [
        { status: { $in: ['pending', 'queued'] } },
        { status: 'rendering', renderId: null },
        { status: 'rendering', renderId: { $regex: /^local-/ } },
      ],
    },
    { status: 'rendering', startedAt: new Date(), renderId: null, progress: 0 },
    { new: true, select: '+inputProps +webhookUrl' }
  );
  if (!claimed) {
    log.warn('Claim failed');
    return { skipped: true, reason: 'claim_failed' };
  }

  try {
    const { renderId, bucketName } = await retryWithBackoff(() => startLambdaRender(claimed), {
      maxRetries: 3,
      initialDelay: 2000,
      onRetry: (err, attempt) => log.warn(`Start retry ${attempt}: ${err.message}`),
    });
    log.info(`Started on Lambda: ${renderId}`);
    await RenderJob.updateOne(
      { _id: jobId, status: 'rendering' },
      { renderId, bucketName, serveUrl: env.remotionServeUrl, lastProgressAt: new Date() }
    );
  } catch (err: any) {
    log.error(`Error (attempt ${job.attemptsMade + 1}): ${err.message}`);
    // Earlier attempts leave the job "rendering" (no renderId) so the retry takes it over.
    if (isFinalAttempt(job)) await failRender(jobId, describeRenderError(err.message), 'render_failed');
    throw err;
  }

  // Webhook mode: Remotion tells us when it's done; free this slot now.
  if (webhookMode()) return { started: true };
  return await pollUntilDone(jobId, log);
}

// ============================================================================
// Local (@remotion/renderer on this worker)
// ============================================================================

export async function processLocalRender(job: Job<RenderJobData>) {
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
  // Local: a render uses every core it gets; run them one (or a few) at a
  // time. Lambda: webhook mode only holds a slot while starting a render;
  // poll mode holds it for the whole render.
  concurrency: env.renderProvider === 'lambda' ? (webhookMode() ? 20 : 3) : env.renderConcurrency,
  lockDuration: 180000,
});

export default renderWorker;
