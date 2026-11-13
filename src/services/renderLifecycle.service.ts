// services/renderLifecycle.service.ts
//
// The one place a render's outcome is decided. The render worker, the
// maintenance sweep and the status endpoint all call these, so every path
// charges, refunds and notifies the same way. Outcomes are conditional
// transitions from "rendering": a duplicate call, a late check or a
// completion after a cancel can't apply twice.

import { RenderJob } from '../models/RenderJob';
import { generateThumbnailFromVideo } from './thumbnail.service';
import { notifyRenderEvent } from './webhook.service';
import { releaseUsage, settleUsage } from './usage.service';
import { transition } from '../utils/jobs';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { deleteOutput, outputFields, parseStorageUrl, presignOutput } from './renderOutput.service';

const ACTIVE_RENDER_STATES = ['pending', 'queued', 'rendering'];

/** A render that hasn't finished this long after starting has failed (RENDER_DEADLINE_MINUTES). */
export const RENDER_DEADLINE_MS = env.renderDeadlineMs;

/** The worker stops a render at the deadline itself; this extra time is for the backstop in checkRender. */
const DEADLINE_GRACE_MS = 5 * 60_000;

export const RENDER_TIMEOUT_MESSAGE = 'The render took too long. Try a shorter video or fewer effects.';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Caption renders are metered per caption project; others per render job. */
export function usageKey(job: { _id: any; renderType?: string; captionProjectId?: any }): {
  kind: 'renderMinutes' | 'captionRenderMinutes';
  jobId: string;
} {
  return job.renderType === 'CaptionProject' && job.captionProjectId
    ? { kind: 'captionRenderMinutes', jobId: `caption-render-${job.captionProjectId}` }
    : { kind: 'renderMinutes', jobId: String(job._id) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turns a raw Remotion error into something safe and useful to show.
 * Raw messages can contain server paths and stack frames, so only known patterns
 * pass through and everything else gets a generic message.
 */
export function describeRenderError(raw?: string): string {
  const msg = raw || '';
  // Our side (no composition bundle on this server yet): not the user's project.
  if (/Remotion bundle not found|REMOTION_SERVE_URL/i.test(msg)) {
    return 'Rendering is temporarily unavailable. Try again in a few minutes.';
  }
  if (/404|not found|failed to load|error loading|ERR_NAME_NOT_RESOLVED|could not be loaded/i.test(msg)) {
    return 'A media file in this project could not be loaded. Re-upload it or remove it, then render again.';
  }
  if (/timeout|timed out/i.test(msg)) return RENDER_TIMEOUT_MESSAGE;
  if (/font/i.test(msg)) {
    return 'A font in this project could not be loaded. Pick a different font and render again.';
  }
  return 'The render failed while processing the video. Try again, and contact support if it keeps failing.';
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

async function notify(job: any, event: 'render.completed' | 'render.failed', payload: Record<string, unknown>): Promise<void> {
  try {
    await notifyRenderEvent(job, event, payload);
  } catch (error: any) {
    // Queue unavailable: the job's own status is already saved.
    logger.warn('Could not queue render webhooks', { jobId: String(job._id), error: error?.message });
  }
}

async function addThumbnail(job: any, renderId: string): Promise<void> {
  const jobId = String(job._id);
  try {
    // The output is private, so ffmpeg reads it through a signed URL.
    const videoUrl = await presignOutput(job);
    if (!videoUrl) return;
    const result = await generateThumbnailFromVideo({ videoUrl, renderId, timestamp: 1, width: 640 });
    if (result.success && result.thumbnailUrl) {
      await RenderJob.updateOne({ _id: jobId }, { thumbnailUrl: result.thumbnailUrl });
    }
  } catch (error: any) {
    logger.warn('Render thumbnail failed', { jobId, error: error?.message });
  }
}

/**
 * Marks a render completed and charges it. Returns false if the job wasn't
 * rendering any more (cancelled, already completed): nothing is charged then.
 */
export async function completeRender(
  jobId: string,
  result: { outputUrl: string; stats?: Record<string, unknown> }
): Promise<boolean> {
  const location = parseStorageUrl(result.outputUrl);
  const job = await transition(RenderJob, jobId, ['rendering'], {
    status: 'completed',
    progress: 100,
    outputUrl: result.outputUrl,
    ...(location ? { outputBucket: location.bucket, outputKey: location.key } : {}),
    completedAt: new Date(),
    ...(result.stats || {}),
  });
  if (!job) {
    // Cancelled (or deleted) while the render kept going: nothing is charged, and
    // the file it produced is removed so it can't be fetched later.
    logger.info('Render finished but the job had already ended; not charging', { jobId });
    const ended = await RenderJob.findById(jobId).select('status').lean();
    if (!ended || ended.status === 'cancelled') {
      await deleteOutput({ _id: jobId, outputUrl: result.outputUrl, ...(location ? { outputBucket: location.bucket, outputKey: location.key } : {}) });
    }
    return false;
  }

  const full = await RenderJob.findById(jobId).select('+inputProps +webhookUrl +shareToken +outputBucket +outputKey');
  if (full) {
    const usage = usageKey(full);
    await settleUsage(full.userId, usage.kind, usage.jobId, Number(full.inputProps?.project?.duration) || 0);
    await notify(full, 'render.completed', outputFields(full));
    // Not awaited: the worker shouldn't wait for ffmpeg before taking the next render.
    void addThumbnail(full, (job as any).renderId || jobId);
  }
  return true;
}

/** Fails an active render with a user-facing message and refunds it. Returns false if it had already ended. */
export async function failRender(jobId: string, message: string, reason: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const job = await transition(RenderJob, jobId, ACTIVE_RENDER_STATES, {
    status: 'failed',
    error: message,
    completedAt: new Date(),
    ...extra,
  });
  if (!job) return false;
  const usage = usageKey(job as any);
  await releaseUsage(usage.kind, usage.jobId, reason);
  const full = await RenderJob.findById(jobId).select('+webhookUrl');
  if (full) await notify(full, 'render.failed', { error: message });
  return true;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type RenderCheck = 'failed' | 'rendering' | 'ended';

/**
 * The render worker saves progress and applies the outcome itself. This is
 * the backstop for a worker that died: a render still "rendering" well past
 * its deadline is failed (and refunded). Safe to call any number of times.
 */
export async function checkRender(job: { _id: any; status: string; startedAt?: Date }): Promise<RenderCheck> {
  if (job.status !== 'rendering') return 'ended';
  const started = job.startedAt ? new Date(job.startedAt).getTime() : 0;
  if (started && Date.now() - started > RENDER_DEADLINE_MS + DEADLINE_GRACE_MS) {
    return (await failRender(String(job._id), RENDER_TIMEOUT_MESSAGE, 'render_timeout')) ? 'failed' : 'ended';
  }
  return 'rendering';
}

const recentChecks = new Map<string, number>();

/**
 * Runs checkRender for a rendering job while someone is watching it (the
 * status endpoint), at most every `minIntervalMs` per job and process.
 * Returns true when it checked (the caller re-reads the job).
 */
export async function refreshIfStale(job: any, minIntervalMs = 3000): Promise<boolean> {
  if (job?.status !== 'rendering') return false;
  const jobId = String(job._id);
  const last = Math.max(recentChecks.get(jobId) || 0, job.lastProgressAt ? new Date(job.lastProgressAt).getTime() : 0);
  if (Date.now() - last < minIntervalMs) return false;
  recentChecks.set(jobId, Date.now());
  if (recentChecks.size > 5000) recentChecks.clear();
  try {
    await checkRender(job);
    return true;
  } catch (error: any) {
    logger.warn('Render progress check failed', { jobId, error: error?.message });
    return false;
  }
}
