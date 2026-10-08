// workers/render.worker.ts

import { Job } from 'bullmq';
import { RenderJob } from '../models/RenderJob';
import { startRemotionRender } from '../services/render.service';
import {
  RENDER_DEADLINE_MS,
  RENDER_TIMEOUT_MESSAGE,
  checkRender,
  describeRenderError,
  failRender,
  webhookMode,
} from '../services/renderLifecycle.service';
import { createWorker, createJobLogger, sleep, retryWithBackoff } from '../utils/worker.utils';
import { env } from '../config/env';
import { isFinalAttempt } from '../utils/jobs';

// ============================================================================
// Types
// ============================================================================

interface RenderJobData {
  jobId: string;
}

// ============================================================================
// Poll mode (local development): wait for the render here
// ============================================================================

async function pollUntilDone(jobId: string, log: ReturnType<typeof createJobLogger>) {
  const deadline = Date.now() + RENDER_DEADLINE_MS + 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
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
      await sleep(3000);
    }
  }
  await failRender(jobId, RENDER_TIMEOUT_MESSAGE, 'render_timeout');
  return { ended: 'timeout' };
}

// ============================================================================
// Main Processor
// ============================================================================

async function processRenderJob(job: Job<RenderJobData>) {
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

  // Already started (a resumed job): check on it instead of starting again.
  if (dbJob.status === 'rendering' && dbJob.renderId && dbJob.bucketName) {
    log.info(`Resuming: ${dbJob.renderId}`);
    if (webhookMode()) return { checked: await checkRender(dbJob) };
    return await pollUntilDone(jobId, log);
  }

  // Claim job. "rendering" without a renderId means an earlier attempt died
  // while starting the render (BullMQ only re-runs a job after its previous
  // worker lost it), so that attempt is taken over instead of staying stuck.
  const claimed = await RenderJob.findOneAndUpdate(
    {
      _id: jobId,
      $or: [{ status: { $in: ['pending', 'queued'] } }, { status: 'rendering', renderId: null }],
    },
    { status: 'rendering', startedAt: new Date() },
    { new: true, select: '+inputProps +webhookUrl' }
  );
  if (!claimed) {
    log.warn('Claim failed');
    return { skipped: true, reason: 'claim_failed' };
  }

  try {
    const { renderId, bucketName } = await retryWithBackoff(() => startRemotionRender(claimed), {
      maxRetries: 3,
      initialDelay: 2000,
      onRetry: (err, attempt) => log.warn(`Start retry ${attempt}: ${err.message}`),
    });
    log.info(`Started: ${renderId}`);

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
// Create Worker
// ============================================================================

const renderWorker = createWorker({
  name: 'render',
  processor: processRenderJob,
  // Crashed or stalled for good: don't leave the render "rendering" forever.
  onFinalFailure: async (job) => {
    await failRender(job.data.jobId, 'The render stopped unexpectedly. Try again.', 'render_crashed');
  },
  // Webhook mode only holds a slot while starting a render; poll mode holds
  // it for the whole render.
  concurrency: webhookMode() ? 20 : 3,
  lockDuration: 180000,
});

export default renderWorker;