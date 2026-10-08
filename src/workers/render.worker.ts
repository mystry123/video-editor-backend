// workers/render.worker.ts

import { Job } from 'bullmq';
import { RenderJob } from '../models/RenderJob';
import { startRemotionRender, checkRemotionProgress } from '../services/render.service';
import { deliverWebhook } from '../services/webhook.service';
import { generateThumbnailFromVideo } from '../services/thumbnail.service';
import { createWorker, createJobLogger, sleep, retryWithBackoff } from '../utils/worker.utils';
import { quotaService } from '../services/quota.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { isFinalAttempt, transition } from '../utils/jobs';

// ============================================================================
// Types
// ============================================================================

interface RenderJobData {
  jobId: string;
}

// ============================================================================
// Helper: user-facing render error
// ============================================================================

/**
 * Turns a raw Remotion/Lambda error into something safe and useful to show.
 * Raw messages can contain AWS ARNs and stack frames, so only known patterns
 * pass through and everything else gets a generic message.
 */
function describeRenderError(raw?: string): string {
  const msg = raw || '';
  if (/404|not found|failed to load|error loading|ERR_NAME_NOT_RESOLVED|could not be loaded/i.test(msg)) {
    return 'A media file in this project could not be loaded. Re-upload it or remove it, then render again.';
  }
  if (/timeout|timed out/i.test(msg)) {
    return 'The render took too long. Try a shorter video or fewer effects.';
  }
  if (/font/i.test(msg)) {
    return 'A font in this project could not be loaded. Pick a different font and render again.';
  }
  return 'The render failed while processing the video. Try again, and contact support if it keeps failing.';
}

// ============================================================================
// Helper: Poll and Complete
// ============================================================================

async function pollAndComplete(
  jobId: string,
  renderId: string,
  bucketName: string,
  webhookUrl: string | undefined,
  log: ReturnType<typeof createJobLogger>
) {
  const maxAttempts = 600; // 20 minutes

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    // Check if cancelled
    const current = await RenderJob.findById(jobId).select('status').lean();
    if (current?.status === 'cancelled') {
      log.info('Cancelled');
      return { cancelled: true };
    }

    try {
      const progress = await checkRemotionProgress(renderId, bucketName);
      const pct = Math.round(progress.progress * 100);

      // Update progress
      const updateData: any = { progress: pct };
      if (progress.framesRendered) updateData.framesRendered = progress.framesRendered;
      if (progress.chunks) updateData.chunks = progress.chunks;
      if (progress.timeToRenderFrames) updateData.timeToRenderFrames = progress.timeToRenderFrames;
      if (progress.timeToFinish) updateData.timeToFinish = progress.timeToFinish;
      if (progress.timeToEncode) updateData.timeToEncode = progress.timeToEncode;
      if (progress.outputSizeInBytes) updateData.outputSizeInBytes = progress.outputSizeInBytes;
      if (progress.lambdasInvoked) updateData.lambdasInvoked = progress.lambdasInvoked;
      if (progress.renderMetadata) updateData.renderMetadata = progress.renderMetadata;
      if (progress.encodingStatus) updateData.encodingStatus = progress.encodingStatus;
      if (progress.errors?.length) updateData.renderErrors = progress.errors;
      if (progress.costs) {
        updateData.estimatedCost = progress.costs.accruedSoFar;
        updateData.costDisplay = progress.costs.displayCost;
        updateData.currency = progress.costs.currency;
      }

      await RenderJob.updateOne({ _id: jobId }, updateData);

      if (i % 5 === 0) log.info(`Progress: ${pct}%`);

      // Lambda gave up — fail now with the real reason instead of polling
      // until the 20-minute timeout.
      if (progress.fatalErrorEncountered) {
        const fatal = progress.errors?.find((e: any) => e?.isFatal) || progress.errors?.[0];
        const reason = describeRenderError(fatal?.message);
        log.error(`Fatal render error: ${fatal?.message || 'unknown'}`);
        await RenderJob.updateOne(
          { _id: jobId, status: 'rendering' },
          { status: 'failed', error: reason, completedAt: new Date() }
        );
        return { error: 'fatal', message: reason };
      }

      // Check completion
      if (progress.done && progress.outputFile) {
        log.info('Complete');

        // Only a job still "rendering" completes (and is charged): a cancel that
        // landed meanwhile wins, and a duplicate completion can't charge twice.
        const completed = await transition(RenderJob, jobId, ['rendering'], {
          status: 'completed',
          progress: 100,
          outputUrl: progress.outputFile,
          completedAt: new Date(),
        });
        if (!completed) {
          log.info('Render finished but the job had already ended; not charging');
          return { skipped: true, reason: 'not_rendering' };
        }

        // Update quota usage for render minutes
        const renderJob = await RenderJob.findById(jobId).select('+inputProps');
        if (renderJob) {
          const userId = renderJob.userId.toString();
          const duration = (renderJob.inputProps?.project?.duration || 0) / 60; // Convert to minutes
          const resolution = renderJob.resolution || '1080p';
          
          // Use caption render minutes if it's a caption render, otherwise regular render minutes
          const quotaType = renderJob.renderType === 'CaptionProject' ? 'captionRenderMinutes' : 'renderMinutes';
          
          if (quotaType === 'captionRenderMinutes') {
            await quotaService.addCaptionRenderMinutes(userId, duration, jobId, resolution);
          } else {
            await quotaService.addRenderMinutes(userId, duration, jobId, resolution);
          }
        }

        // Generate thumbnail (async, don't wait)
        generateThumbnailFromVideo({
          videoUrl: progress.outputFile,
          renderId,
        })
          .then((result) => {
            if (result.success && result.thumbnailUrl) {
              RenderJob.updateOne({ _id: jobId }, { thumbnailUrl: result.thumbnailUrl });
            }
          })
          .catch(() => {});

        // Deliver webhook (async, don't wait)
        if (webhookUrl) {
          deliverWebhook(webhookUrl, {
            event: 'render.completed',
            jobId,
            outputUrl: progress.outputFile,
          })
            .then(() => RenderJob.updateOne({ _id: jobId }, { webhookSent: true }))
            .catch(() => {});
        }

        return { success: true, outputUrl: progress.outputFile };
      }
    } catch (err: any) {
      log.warn(`Poll error: ${err.message}`);
      await sleep(3000);
    }
  }

  // Timeout
  log.error('Timeout');
  await transition(RenderJob, jobId, ['rendering'], {
    status: 'failed',
    error: 'The render took too long. Try a shorter video or fewer effects.',
    completedAt: new Date(),
  });
  return { error: 'timeout' };
}

// ============================================================================
// Main Processor
// ============================================================================

async function processRenderJob(job: Job<RenderJobData>) {
  const { jobId } = job.data;
  const log = createJobLogger('Render', jobId);

  log.info('Processing');

  // Load job
  const dbJob = await RenderJob.findById(jobId).select('+inputProps +webhookUrl');
  if (!dbJob) {
    log.warn('Not found');
    return { skipped: true, reason: 'not_found' };
  }

  // Skip if already processed
  if (['completed', 'failed', 'cancelled'].includes(dbJob.status)) {
    // Add missing thumbnail for completed jobs
    if (dbJob.status === 'completed' && dbJob.outputUrl && !dbJob.thumbnailUrl) {
      try {
        const result = await generateThumbnailFromVideo({
          videoUrl: dbJob.outputUrl,
          renderId: dbJob.renderId || jobId,
        });
        if (result.success && result.thumbnailUrl) {
          await RenderJob.updateOne({ _id: jobId }, { thumbnailUrl: result.thumbnailUrl });
        }
      } catch {
        // Thumbnail backfill is optional; the render itself is done.
      }
    }
    return { skipped: true, reason: dbJob.status };
  }

  // Resume if already rendering
  if (dbJob.status === 'rendering' && dbJob.renderId && dbJob.bucketName) {
    log.info(`Resuming: ${dbJob.renderId}`);
    return await pollAndComplete(jobId, dbJob.renderId, dbJob.bucketName, dbJob.webhookUrl, log);
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
    // Start render with retry
    const { renderId, bucketName } = await retryWithBackoff(
      () => startRemotionRender(claimed),
      {
        maxRetries: 3,
        initialDelay: 2000,
        onRetry: (err, attempt) => log.warn(`Start retry ${attempt}: ${err.message}`),
      }
    );

    log.info(`Started: ${renderId}`);

    await RenderJob.updateOne(
      { _id: jobId },
      { renderId, bucketName, serveUrl: env.remotionServeUrl }
    );

    return await pollAndComplete(jobId, renderId, bucketName, claimed.webhookUrl, log);
  } catch (err: any) {
    log.error(`Error (attempt ${job.attemptsMade + 1}): ${err.message}`);
    // Earlier attempts leave the job "rendering" (no renderId) so the retry takes it over.
    if (isFinalAttempt(job)) {
      await transition(RenderJob, jobId, ['pending', 'queued', 'rendering'], {
        status: 'failed',
        error: describeRenderError(err.message),
        completedAt: new Date(),
      });
    }
    throw err;
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const renderWorker = createWorker({
  name: 'render',
  processor: processRenderJob,
  // Crashed or stalled for good: don't leave the render "rendering" forever.
  onFinalFailure: async (job) => {
    await transition(RenderJob, job.data.jobId, ['pending', 'queued', 'rendering'], {
      status: 'failed',
      error: 'The render stopped unexpectedly. Try again.',
      completedAt: new Date(),
    });
  },
  concurrency: 3,
  lockDuration: 180000, // 3 minutes (renders are long)
});

export default renderWorker;