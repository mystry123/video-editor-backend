// workers/caption.worker.ts
import { enqueueJob, transition } from '../utils/jobs';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { Types } from 'mongoose';
import { refreshIfStale } from '../services/renderLifecycle.service';
import { ensureShareTokens, outputFields } from '../services/renderOutput.service';
import { getEffectiveQuota } from '../config/quotas';

import { Job } from 'bullmq';
import { ACTIVE_CAPTION_STATES, CaptionProject, ICaptionProject } from '../models/Caption';
import { Transcription } from '../models/Transcription';
import { File } from '../models/File';
import { Template } from '../models/Template';
import { User } from '../models/User';
import { RenderJob } from '../models/RenderJob';
import { CaptionCompositionService } from '../services/captioncomposition.service';
import { CaptionGenerationOutput } from '../types/composition';
import { CaptionPreset } from '../models/CaptionPreset';
import { createWorker, createJobLogger, sleep } from '../utils/worker.utils';
import { quotaService } from '../services/quota.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { transcriptionQueue, renderQueue } from '../queues';

// ============================================================================
// Types
// ============================================================================

interface CaptionJobData {
  projectId: string;
  hasExistingTranscription?: boolean;
}

// ============================================================================
// Helper: Wait for Transcription
// ============================================================================

async function waitForTranscription(
  transcriptionId: string,
  projectId: string,
  log: ReturnType<typeof createJobLogger>
): Promise<{ success: boolean; error?: string }> {
  const maxAttempts = 300; // 10 minutes

  for (let i = 0; i < maxAttempts; i++) {
    const transcription = await Transcription.findById(transcriptionId).lean();

    if (!transcription) {
      return { success: false, error: 'Transcription not found' };
    }

    if (transcription.status === 'completed') {
      log.info('Transcription completed');
      return { success: true };
    }

    if (transcription.status === 'failed') {
      return { success: false, error: `Transcription failed: ${transcription.error}` };
    }

    // Check if cancelled
    const project = await CaptionProject.findById(projectId).select('status').lean();
    if (!project || project.status === 'failed') {
      return { success: false, error: 'Project cancelled' };
    }

    if (i % 15 === 0) {
      log.info(`Waiting for transcription... (${transcription.status})`);
    }

    await sleep(2000);
  }

  return { success: false, error: 'Transcription timeout' };
}

// ============================================================================
// Helper: Wait for Render
// ============================================================================

async function waitForRender(
  renderJobId: string,
  projectId: string,
  log: ReturnType<typeof createJobLogger>
): Promise<{ success: boolean; outputUrl?: string; thumbnailUrl?: string; error?: string }> {
  const maxAttempts = 600; // 20 minutes

  for (let i = 0; i < maxAttempts; i++) {
    let renderJob = await RenderJob.findById(renderJobId).lean();

    if (!renderJob) {
      return { success: false, error: 'Render job not found' };
    }

    // In webhook mode nothing else reads progress from Lambda while we wait.
    if (await refreshIfStale(renderJob, 5000)) {
      renderJob = (await RenderJob.findById(renderJobId).lean()) ?? renderJob;
    }

    // Update progress
    if (typeof renderJob.progress === 'number') {
      await CaptionProject.updateOne({ _id: projectId }, { progress: renderJob.progress });
    }

    if (renderJob.status === 'completed' && renderJob.outputUrl) {
      log.info('Render completed');
      // Store the render's Shotline link: the file itself is private.
      const [linked] = await ensureShareTokens([renderJob as any]);
      return {
        success: true,
        outputUrl: outputFields(linked).outputUrl,
        thumbnailUrl: renderJob.thumbnailUrl,
      };
    }

    if (renderJob.status === 'failed') {
      return { success: false, error: `Render failed: ${renderJob.error}` };
    }

    if (renderJob.status === 'cancelled') {
      return { success: false, error: 'Render cancelled' };
    }

    // Check if cancelled
    const project = await CaptionProject.findById(projectId).select('status').lean();
    if (!project || project.status === 'failed') {
      return { success: false, error: 'Project cancelled' };
    }

    if (i % 15 === 0) {
      log.info(`Rendering... ${renderJob.progress || 0}%`);
    }

    await sleep(2000);
  }

  return { success: false, error: 'Render timeout' };
}

// ============================================================================
// Main Processor
// ============================================================================

async function processCaptionJob(job: Job<CaptionJobData>) {
  const { projectId } = job.data;
  const log = createJobLogger('Caption', projectId);

  log.info('Processing started');

  // Load project
  const project = await CaptionProject.findById(projectId);
  if (!project) {
    log.warn('Project not found');
    return { skipped: true, reason: 'not_found' };
  }

  // Skip if already processed
  if (['completed', 'failed'].includes(project.status)) {
    log.info(`Already ${project.status}`);
    return { skipped: true, reason: project.status };
  }

  const userId = project.userId.toString();
  const fileId = project.fileId.toString();

  try {
    // Update quota usage for caption project (only if this is the first time processing)
    if (project.status === 'pending') {
      await quotaService.addCaptionProject(userId, projectId);
    }
    // =======================================================================
    // STAGE 1: TRANSCRIPTION (0-40%)
    // =======================================================================

    let transcriptionId = project.transcriptionId?.toString();

    if (!transcriptionId) {
      log.info('Starting transcription');

      await CaptionProject.updateOne(
        { _id: projectId },
        { status: 'transcribing', transcriptionStartedAt: new Date(), progress: 5 }
      );

      const file = await File.findById(fileId).lean();
      if (!file || !file.cdnUrl) {
        throw new Error('File not found or missing CDN URL');
      }

      // Check for existing transcription
      let transcription = await Transcription.findOne({ fileId, status: 'completed' }).lean();

      if (transcription) {
        log.info('Found existing transcription');
        transcriptionId = transcription._id.toString();
      } else {
        // Check for in-progress
        transcription = await Transcription.findOne({
          fileId,
          status: { $in: ['pending', 'processing'] },
        }).lean();

        if (transcription) {
          log.info('Found in-progress transcription');
          transcriptionId = transcription._id.toString();
        } else {
          // Create one, or retry a failed one (fileId is unique, so creating a
          // second would fail on every attempt). Its minutes are reserved
          // against the owner's transcription limit first.
          const failed = await Transcription.findOne({ fileId, status: 'failed' }).select('_id').lean();
          const newId = failed ? failed._id : new Types.ObjectId();
          const owner = await User.findById(userId);
          if (!(await reserveOrFail(projectId, () =>
            reserveUsage(userId, 'transcriptionMinutes', String(newId), Number(file.metadata?.duration) || 0,
              owner ? getEffectiveQuota(owner).maxTranscriptionMinutes : 0)
          ))) {
            return { success: false, stage: 'transcription', reason: 'quota' };
          }
          if (failed) {
            await Transcription.updateOne({ _id: newId }, { status: 'pending', $unset: { error: '' } });
          } else {
            await Transcription.create({ _id: newId, userId, fileId, status: 'pending' });
          }
          transcriptionId = String(newId);

          await enqueueJob(
            transcriptionQueue,
            'transcribe',
            { transcriptionId, fileUrl: file.cdnUrl },
            { jobId: `transcription-${transcriptionId}` }
          );

          log.info(`Created transcription: ${transcriptionId}`);
        }

        // Wait for completion
        const result = await waitForTranscription(transcriptionId, projectId, log);
        if (!result.success) {
          await CaptionProject.updateOne(
            { _id: projectId },
            { status: 'failed', error: result.error, progress: 20 }
          );
          return { success: false, stage: 'transcription' };
        }
      }

      await CaptionProject.updateOne(
        { _id: projectId },
        { transcriptionId, transcriptionCompletedAt: new Date(), progress: 40 }
      );
    } else {
      log.info('Using existing transcription');
      await CaptionProject.updateOne({ _id: projectId }, { progress: 40 });
    }

    // =======================================================================
    // STAGE 2: GENERATE COMPOSITION (40-50%)
    // =======================================================================

    log.info('Generating composition');

    await CaptionProject.updateOne(
      { _id: projectId },
      { status: 'generating', generationStartedAt: new Date(), progress: 42 }
    );

    const compositionResult: CaptionGenerationOutput = await CaptionCompositionService.generate({
      fileId,
      transcriptionId: transcriptionId!,
      presetId: project.presetId?.toString(),
      settings: project.settings,
      name: project.name,
    });


    await CaptionProject.updateOne(
      { _id: projectId },
      {
        composition: compositionResult.composition,
        generationCompletedAt: new Date(),
        progress: 50,
      }
    );

    // =======================================================================
    // STAGE 3: RENDER (50-95%)
    // =======================================================================

    log.info('Starting render');

    await CaptionProject.updateOne(
      { _id: projectId },
      { status: 'rendering', renderStartedAt: new Date() }
    );

    const composition = compositionResult.composition;

    // Reserve the caption render minutes (keyed by project, so a retried
    // pipeline reuses the same reservation). Out of minutes fails the project
    // with a clear message instead of rendering for free.
    // The export itself is counted too (settled when the project completes).
    const owner = await User.findById(userId);
    const ownerQuota = owner ? getEffectiveQuota(owner) : null;
    const reserved =
      (await reserveOrFail(projectId, () =>
        reserveUsage(userId, 'captionExports', `caption-export-${projectId}`, 1, ownerQuota?.maxCaptionExports ?? 0)
      )) &&
      (await reserveOrFail(projectId, () =>
        reserveUsage(userId, 'captionRenderMinutes', `caption-render-${projectId}`, Number(composition.project?.duration) || 0,
          ownerQuota?.maxCaptionRenderMinutes ?? 0)
      ));
    if (!reserved) {
      await releaseUsage('captionExports', `caption-export-${projectId}`, 'quota');
      return { success: false, stage: 'rendering', reason: 'quota' };
    }

    const renderJob = await RenderJob.create({
      userId,
      captionProjectId: projectId,
      inputProps: composition,
      outputFormat: composition.project?.outputFormat || 'mp4',
      resolution: composition.project?.height ? `${composition.project.height}p` : '1080p',
      renderType: 'CaptionProject',
      fps: composition.project?.fps || 30,
      status: 'pending',
    });

    await CaptionProject.updateOne({ _id: projectId }, { renderJobId: renderJob._id });

    await enqueueJob(renderQueue, 'render', { jobId: renderJob._id.toString() }, { jobId: `render-${renderJob._id}`, priority: 1 });

    const renderResult = await waitForRender(renderJob._id.toString(), projectId, log);

    if (!renderResult.success) {
      await CaptionProject.updateOne(
        { _id: projectId },
        { status: 'failed', error: renderResult.error }
      );
      await releaseCaptionUsage(projectId, 'render_failed');
      return { success: false, stage: 'rendering' };
    }

    // =======================================================================
    // STAGE 4: COMPLETE (100%)
    // =======================================================================

    log.info('Completed!');

    // Only an active project completes: a cancellation (status failed) wins.
    const completed = await transition(CaptionProject, projectId, ACTIVE_CAPTION_STATES, {
      status: 'completed',
      outputUrl: renderResult.outputUrl,
      thumbnailUrl: renderResult.thumbnailUrl,
      renderCompletedAt: new Date(),
      progress: 100,
    });
    if (completed) {
      await settleUsage(userId, 'captionExports', `caption-export-${projectId}`);
    } else {
      await releaseUsage('captionExports', `caption-export-${projectId}`, 'cancelled');
    }

    return {
      success: true,
      outputUrl: renderResult.outputUrl,
      thumbnailUrl: renderResult.thumbnailUrl,
    };
  } catch (error: any) {
    log.error(`Error: ${error.message}`);

    await transition(CaptionProject, projectId, ACTIVE_CAPTION_STATES, { status: 'failed', error: error.message });
    await releaseCaptionUsage(projectId, 'caption_failed');

    throw error;
  }
}


// ============================================================================
// Create Worker
// ============================================================================

/** Refunds a caption project's reserved render minutes and export. */
async function releaseCaptionUsage(projectId: string, reason: string): Promise<void> {
  await releaseUsage('captionRenderMinutes', `caption-render-${projectId}`, reason);
  await releaseUsage('captionExports', `caption-export-${projectId}`, reason);
}

/**
 * Runs a reservation; when the user is out of quota, fails the project with
 * the quota message and returns false (other errors are thrown for a retry).
 */
async function reserveOrFail(projectId: string, reserve: () => Promise<void>): Promise<boolean> {
  try {
    await reserve();
    return true;
  } catch (error: any) {
    if (error?.statusCode !== 403) throw error;
    await transition(CaptionProject, projectId, ACTIVE_CAPTION_STATES, { status: 'failed', error: error.message });
    return false;
  }
}

const captionWorker = createWorker({
  name: 'caption',
  processor: processCaptionJob,
  // Crashed or stalled for good: don't leave the project in progress forever.
  onFinalFailure: async (job) => {
    await transition(CaptionProject, job.data.projectId, ACTIVE_CAPTION_STATES, {
      status: 'failed',
      error: 'Captioning stopped unexpectedly. Try again.',
    });
    await releaseCaptionUsage(job.data.projectId, 'caption_crashed');
  },
  concurrency: 5,
  lockDuration: 120000, // 2 minutes
});

export default captionWorker;