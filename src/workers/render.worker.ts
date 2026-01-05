import { Worker, Job } from 'bullmq';
import { redis } from '../config/redis';
import { RenderJob } from '../models/RenderJob';
import { startRemotionRender, checkRemotionProgress } from '../services/render.service';
import { triggerWebhooks, deliverWebhook } from '../services/webhook.service';
import { copyToCDN } from '../services/storage.service';
import { sleep } from '../utils/helpers';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const renderWorker = new Worker(
  'render',
  async (job: Job) => {
    const { jobId } = job.data;
    const renderJob = await RenderJob.findById(jobId);

    if (!renderJob || renderJob.status === 'cancelled') {
      logger.info('Render job cancelled or not found', { jobId });
      return;
    }

    try {
      // Start Lambda render
      logger.info('Attempting to start render', { jobId, renderJobData: renderJob });
      
      const { renderId, bucketName } = await startRemotionRender(renderJob);
      logger.info('Render started', { renderId, bucketName, jobId });

      await RenderJob.updateOne(
        { _id: jobId },
        {
          renderId,
          bucketName,
          serveUrl: env.remotionServeUrl,
          status: 'rendering',
          startedAt: new Date(),
        }
      );
      
      logger.info('Job status updated to rendering', { jobId });

      // Poll for progress
      let isComplete = false;
      while (!isComplete) {
        await sleep(2000);

        // Check if cancelled
        const currentJob = await RenderJob.findById(jobId);
        if (currentJob?.status === 'cancelled') {
          logger.info('Render job cancelled during processing', { jobId });
          break;
        }

        try {
          const progress = await checkRemotionProgress(renderId, bucketName);
          
          // Store ALL progress information
          const updateData: any = {
            progress: Math.round(progress.progress * 100),
          };

          // Store every field from the progress response
          const fieldsToStore = [
            'framesRendered', 'chunks', 'timeToRenderFrames', 'timeToFinish',
            'timeToFinishChunks', 'timeToEncode', 'outputSizeInBytes', 
            'estimatedBillingDurationInMilliseconds', 'timeToCombine', 
            'combinedFrames', 'lambdasInvoked', 'fatalErrorEncountered',
            'renderSize', 'currentTime', 'type', 'outKey', 'outBucket',
            'timeoutTimestamp', 'compositionValidated', 'functionLaunched',
            'serveUrlOpened', 'artifacts', 'renderMetadata'
          ];

          fieldsToStore.forEach(field => {
            if (progress[field as keyof typeof progress] !== undefined) {
              updateData[field] = progress[field as keyof typeof progress];
            }
          });

          // Cost information
          if (progress.costs) {
            updateData.estimatedCost = progress.costs.accruedSoFar;
            updateData.costDisplay = progress.costs.displayCost;
            updateData.currency = progress.costs.currency;
          }

          // Encoding status
          if (progress.encodingStatus) {
            updateData.encodingStatus = progress.encodingStatus;
          }

          // Cleanup information
          if (progress.cleanup) {
            updateData.cleanup = progress.cleanup;
          }

          // Most expensive frame ranges
          if (progress.mostExpensiveFrameRanges) {
            updateData.mostExpensiveFrameRanges = progress.mostExpensiveFrameRanges;
          }

          // Errors
          if (progress.errors && progress.errors.length > 0) {
            updateData.renderErrors = progress.errors;
          }

          console.log('Render progress: updated data', JSON.stringify(updateData, null, 2));

          await RenderJob.updateOne(
            { _id: jobId },
            updateData
          );

          if (progress.done) {
            isComplete = true;
            
          
            await RenderJob.updateOne(
              { _id: jobId },
              {
                status: 'completed',
                progress: 100,
                outputUrl: progress.outputFile || null,
                completedAt: new Date(),
              }
            );

            // Send custom webhook if configured
            if (renderJob.webhookUrl) {
              try {
                await deliverWebhook(renderJob.webhookUrl, {
                  event: 'render.completed',
                  jobId,
                  outputUrl: progress.outputFile || null,
                });

                await RenderJob.updateOne({ _id: jobId }, { webhookSent: true });
              } catch (webhookError) {
                logger.error('Custom webhook failed', { jobId, error: webhookError });
              }
            }

            logger.info('Render completed', { jobId, outputUrl: progress.outputFile || null });
          }
        } catch (progressError: any) {
          logger.error('Progress check failed', { jobId, error: progressError.message });
          await sleep(5000); // Wait longer before retrying
        }
      }
    } catch (startError: any) {
      logger.error('Failed to start render', { 
        jobId, 
        error: startError.message,
        stack: startError.stack
      });
      
      // Update job status to failed immediately
      await RenderJob.updateOne(
        { _id: jobId },
        {
          status: 'failed',
          error: startError.message,
        }
      );
      
      throw startError;
    }
  },
  {
    connection: redis,
    concurrency: 10,
  }
);

renderWorker.on('failed', (job, err) => {
  logger.error(`Render job ${job?.id} failed:`, err);
});

renderWorker.on('completed', (job) => {
  logger.info(`Render job ${job.id} completed`);
});

export default renderWorker;
