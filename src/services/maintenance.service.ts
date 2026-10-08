// services/maintenance.service.ts
//
// Sweeper that repairs what crashes, deploys and lost queue writes leave
// behind. Runs every minute as a BullMQ job scheduler (one run at a time,
// across all worker processes). Before touching a record it checks whether
// that record's queue job is still waiting or running, so it never interferes
// with work in progress.

import { Types } from 'mongoose';
import { RenderJob } from '../models/RenderJob';
import { Transcription } from '../models/Transcription';
import { ACTIVE_CAPTION_STATES, CaptionProject } from '../models/Caption';
import { UsageEntry } from '../models/Usage';
import { releaseUsage, settleUsage } from './usage.service';
import { File } from '../models/File';
import {
  getCaptionQueue,
  getFileImportQueue,
  getReframeQueue,
  getRenderQueue,
  getTranscriptionQueue,
} from '../queues';
import { deleteFromS3 } from '../services/storage.service';
import { enqueueJob, transition } from '../utils/jobs';
import { logger } from '../utils/logger';

const MINUTE = 60_000;
/** A record this long untouched with no live queue job is stuck. */
const STUCK_AFTER_MS = 15 * MINUTE;
/** "pending" this long with no queue job means the enqueue was lost. */
const LOST_ENQUEUE_AFTER_MS = 2 * MINUTE;
/** Uploads/imports this old that never finished are abandoned. */
const ABANDONED_AFTER_MS = 2 * 60 * MINUTE;
/** Renders that can still be resumed (Remotion keeps progress this long). */
const RESUMABLE_RENDER_MS = 2 * 60 * MINUTE;
/** Max records handled per category per run, so one run stays short. */
const BATCH = 50;

const REFRAME_KEYS = ['9_16', '1_1', '4_5', '16_9'];
const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

async function hasLiveJob(queue: { getJob: (id: string) => Promise<any> }, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return !!job && LIVE_STATES.has(await job.getState());
}

const ago = (ms: number) => new Date(Date.now() - ms);

// ---------------------------------------------------------------------------

async function sweepRenders(counts: Record<string, number>) {
  const queue = getRenderQueue();

  // Queued in the database but the queue add was lost.
  const pending = await RenderJob.find({ status: { $in: ['pending', 'queued'] }, updatedAt: { $lt: ago(LOST_ENQUEUE_AFTER_MS) } })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const r of pending) {
    const id = String(r._id);
    if (await hasLiveJob(queue, `render-${id}`)) continue;
    await enqueueJob(queue, 'render', { jobId: id }, { jobId: `render-${id}` });
    counts.rendersRequeued = (counts.rendersRequeued || 0) + 1;
  }

  // "rendering" but nothing has updated it for a while: the worker polling it died.
  const stale = await RenderJob.find({ status: 'rendering', updatedAt: { $lt: ago(STUCK_AFTER_MS) } })
    .select('_id renderId startedAt')
    .limit(BATCH)
    .lean();
  for (const r of stale) {
    const id = String(r._id);
    if (await hasLiveJob(queue, `render-${id}`)) continue;
    const resumable = r.renderId && r.startedAt && r.startedAt > ago(RESUMABLE_RENDER_MS);
    if (resumable) {
      // The render worker resumes polling Remotion from renderId.
      await enqueueJob(queue, 'render', { jobId: id }, { jobId: `render-${id}` });
      counts.rendersResumed = (counts.rendersResumed || 0) + 1;
    } else {
      await transition(RenderJob, id, ['rendering'], {
        status: 'failed',
        error: 'The render stopped unexpectedly. Try again.',
        completedAt: new Date(),
      });
      counts.rendersFailed = (counts.rendersFailed || 0) + 1;
    }
  }
}

async function sweepTranscriptions(counts: Record<string, number>) {
  const queue = getTranscriptionQueue();
  const stuck = await Transcription.find({ status: { $in: ['pending', 'processing'] }, updatedAt: { $lt: ago(STUCK_AFTER_MS) } })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const t of stuck) {
    const id = String(t._id);
    if (await hasLiveJob(queue, `transcription-${id}`)) continue;
    await transition(Transcription, id, ['pending', 'processing'], {
      status: 'failed',
      error: 'Transcription stopped unexpectedly. Try again.',
    });
    counts.transcriptionsFailed = (counts.transcriptionsFailed || 0) + 1;
  }
}

async function sweepCaptions(counts: Record<string, number>) {
  const queue = getCaptionQueue();
  const active = ['pending', 'transcribing', 'generating', 'rendering'];
  const stuck = await CaptionProject.find({ status: { $in: active }, updatedAt: { $lt: ago(STUCK_AFTER_MS) } })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const p of stuck) {
    const id = String(p._id);
    if (await hasLiveJob(queue, `caption-${id}`)) continue;
    await transition(CaptionProject, id, active, { status: 'failed', error: 'Captioning stopped unexpectedly. Try again.' });
    counts.captionsFailed = (counts.captionsFailed || 0) + 1;
  }
}

async function sweepReframes(counts: Record<string, number>) {
  const queue = getReframeQueue();
  const files = await File.find({
    updatedAt: { $lt: ago(STUCK_AFTER_MS) },
    $or: REFRAME_KEYS.map((key) => ({ [`reframe.${key}.status`]: { $in: ['pending', 'processing'] } })),
  })
    .select('_id reframe')
    .limit(BATCH)
    .lean();
  for (const file of files) {
    const reframe: any = (file as any).reframe || {};
    for (const key of REFRAME_KEYS) {
      const status = reframe[key]?.status;
      if (status !== 'pending' && status !== 'processing') continue;
      if (await hasLiveJob(queue, `reframe-${file._id}-${key}`)) continue;
      await File.updateOne(
        { _id: file._id, [`reframe.${key}.status`]: status },
        { $set: { [`reframe.${key}.status`]: 'failed', [`reframe.${key}.error`]: 'Reframe stopped unexpectedly. Try again.' } }
      );
      counts.reframesFailed = (counts.reframesFailed || 0) + 1;
    }
  }
}

async function sweepFiles(counts: Record<string, number>) {
  // Upload URL requested but the browser never finished: nothing was charged,
  // so remove the record and any partial object.
  const abandoned = await File.find({ status: 'processing', source: 'upload', createdAt: { $lt: ago(ABANDONED_AFTER_MS) } })
    .select('_id storageKey')
    .limit(BATCH)
    .lean();
  for (const f of abandoned) {
    if (f.storageKey) await deleteFromS3(f.storageKey).catch(() => undefined);
    await File.deleteOne({ _id: f._id, status: 'processing' });
    counts.abandonedUploadsRemoved = (counts.abandonedUploadsRemoved || 0) + 1;
  }

  // Imports that never finished and have no queue job left.
  const queue = getFileImportQueue();
  const imports = await File.find({ status: 'processing', source: { $in: ['url', 'google_drive'] }, updatedAt: { $lt: ago(ABANDONED_AFTER_MS) } })
    .select('_id source')
    .limit(BATCH)
    .lean();
  for (const f of imports) {
    const jobId = f.source === 'url' ? `url-import-${f._id}` : `gdrive-import-${f._id}`;
    if (await hasLiveJob(queue, jobId)) continue;
    await File.updateOne({ _id: f._id, status: 'processing' }, { status: 'failed', importError: 'The import stopped unexpectedly. Try again.' });
    counts.importsFailed = (counts.importsFailed || 0) + 1;
  }
}

// ---------------------------------------------------------------------------

/** Runs every repair step once; returns what was fixed. */
// ---------------------------------------------------------------------------
// Usage reservations whose charge or refund was lost
// ---------------------------------------------------------------------------

/** Where a reservation's work ended up: 'done' (charge), 'gone' (refund) or still running. */
async function reservationOutcome(kind: string, jobId: string): Promise<'done' | 'gone' | 'running'> {
  const finalState = (status: string | undefined, done: string[], active: string[]) =>
    status && done.includes(status) ? 'done' : status && active.includes(status) ? 'running' : 'gone';
  if (kind === 'renderMinutes') {
    const job = Types.ObjectId.isValid(jobId) ? await RenderJob.findById(jobId).select('status').lean() : null;
    return finalState(job?.status, ['completed'], ['pending', 'queued', 'rendering']);
  }
  if (kind === 'transcriptionMinutes') {
    const t = Types.ObjectId.isValid(jobId) ? await Transcription.findById(jobId).select('status').lean() : null;
    return finalState(t?.status, ['completed'], ['pending', 'processing']);
  }
  if (kind === 'captionRenderMinutes' || kind === 'captionExports') {
    const projectId = jobId.replace(/^caption-(render|export)-/, '');
    const p = Types.ObjectId.isValid(projectId) ? await CaptionProject.findById(projectId).select('status').lean() : null;
    return finalState(p?.status, ['completed'], ACTIVE_CAPTION_STATES);
  }
  return 'running'; // unknown kinds are left alone
}

async function sweepUsage(counts: Record<string, number>) {
  const stale = await UsageEntry.find({ state: 'reserved', updatedAt: { $lt: ago(STUCK_AFTER_MS) } })
    .limit(BATCH)
    .lean();
  for (const entry of stale) {
    const outcome = await reservationOutcome(entry.kind, entry.jobId);
    if (outcome === 'done') {
      await settleUsage(entry.userId, entry.kind, entry.jobId);
      counts.reservationsSettled = (counts.reservationsSettled || 0) + 1;
    } else if (outcome === 'gone') {
      await releaseUsage(entry.kind, entry.jobId, 'sweep');
      counts.reservationsReleased = (counts.reservationsReleased || 0) + 1;
    }
  }
}

export async function runMaintenanceSweep(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const steps: Array<[string, (c: Record<string, number>) => Promise<void>]> = [
    ['renders', sweepRenders],
    ['transcriptions', sweepTranscriptions],
    ['captions', sweepCaptions],
    ['reframes', sweepReframes],
    ['files', sweepFiles],
    // Last, so records the steps above just failed get their minutes back.
    ['usage', sweepUsage],
  ];
  // One failing step must not stop the others.
  for (const [name, step] of steps) {
    try {
      await step(counts);
    } catch (error: any) {
      logger.error(`[Maintenance] Sweep step "${name}" failed`, { error: error.message });
    }
  }
  if (Object.keys(counts).length > 0) logger.info('[Maintenance] Repaired stuck work', counts);
  return counts;
}
