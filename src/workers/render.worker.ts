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

// ============================================================================
// Types
// ============================================================================

interface RenderJobData {
  jobId: string;
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

      // Check completion
      if (progress.done && progress.outputFile) {
        log.info('Complete');

        await RenderJob.updateOne(
          { _id: jobId },
          {
            status: 'completed',
            progress: 100,
            outputUrl: progress.outputFile,
            completedAt: new Date(),
          }
        );

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
  await RenderJob.updateOne({ _id: jobId }, { status: 'failed', error: 'Render timeout' });
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
      } catch {}
    }
    return { skipped: true, reason: dbJob.status };
  }

  // Resume if already rendering
  if (dbJob.status === 'rendering' && dbJob.renderId && dbJob.bucketName) {
    log.info(`Resuming: ${dbJob.renderId}`);
    return pollAndComplete(jobId, dbJob.renderId, dbJob.bucketName, dbJob.webhookUrl, log);
  }

  // Claim job
  const claimed = await RenderJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ['pending', 'queued'] } },
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

    return pollAndComplete(jobId, renderId, bucketName, claimed.webhookUrl, log);
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    await RenderJob.updateOne({ _id: jobId }, { status: 'failed', error: err.message });
    throw err;
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const renderWorker = createWorker({
  name: 'render',
  processor: processRenderJob,
  concurrency: 3,
  lockDuration: 180000, // 3 minutes (renders are long)
});

export default renderWorker;