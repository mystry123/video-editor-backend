// workers/caption.worker.ts

import { Job } from 'bullmq';
import { CaptionProject, ICaptionProject } from '../models/Caption';
import { Transcription } from '../models/Transcription';
import { File } from '../models/File';
import { Template } from '../models/Template';
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
    const renderJob = await RenderJob.findById(renderJobId).lean();

    if (!renderJob) {
      return { success: false, error: 'Render job not found' };
    }

    // Update progress
    if (typeof renderJob.progress === 'number') {
      await CaptionProject.updateOne({ _id: projectId }, { progress: renderJob.progress });
    }

    if (renderJob.status === 'completed' && renderJob.outputUrl) {
      log.info('Render completed');
      return {
        success: true,
        outputUrl: renderJob.outputUrl,
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
          // Create new
          const newTranscription = await Transcription.create({
            userId,
            fileId,
            status: 'pending',
          });
          transcriptionId = newTranscription._id.toString();

          await transcriptionQueue.add('transcribe', {
            transcriptionId,
            fileUrl: file.cdnUrl,
          });

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

    await renderQueue.add('render', { jobId: renderJob._id.toString() }, { priority: 1 });

    const renderResult = await waitForRender(renderJob._id.toString(), projectId, log);

    if (!renderResult.success) {
      await CaptionProject.updateOne(
        { _id: projectId },
        { status: 'failed', error: renderResult.error }
      );
      return { success: false, stage: 'rendering' };
    }

    // =======================================================================
    // STAGE 4: COMPLETE (100%)
    // =======================================================================

    log.info('Completed!');

    await CaptionProject.updateOne(
      { _id: projectId },
      {
        status: 'completed',
        outputUrl: renderResult.outputUrl,
        thumbnailUrl: renderResult.thumbnailUrl,
        renderCompletedAt: new Date(),
        progress: 100,
      }
    );

    return {
      success: true,
      outputUrl: renderResult.outputUrl,
      thumbnailUrl: renderResult.thumbnailUrl,
    };
  } catch (error: any) {
    log.error(`Error: ${error.message}`);

    await CaptionProject.updateOne(
      { _id: projectId },
      { status: 'failed', error: error.message }
    );

    throw error;
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const captionWorker = createWorker({
  name: 'caption',
  processor: processCaptionJob,
  concurrency: 5,
  lockDuration: 120000, // 2 minutes
});

export default captionWorker;