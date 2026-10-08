// utils/jobs.ts
//
// Helpers that keep background jobs and their database records consistent.
//
// - enqueueJob: one queue job per record (jobId), so double-clicks and retries
//   don't start duplicate work; fails fast with 503 QUEUE_UNAVAILABLE instead
//   of hanging when Redis is down.
// - transition: change a record's status only from the states you expect, so
//   a late write can't overwrite a cancellation or a newer result.
// - isFinalAttempt: whether a failing job will be retried by BullMQ.

import type { Job, JobsOptions } from 'bullmq';
import type { Model } from 'mongoose';
import { ApiError } from './ApiError';
import { logger } from './logger';

interface QueueLike {
  add: (name: string, data: any, opts?: JobsOptions) => Promise<{ id?: string }>;
  getJob: (id: string) => Promise<any>;
}

const STILL_QUEUED = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

export class QueueUnavailableError extends ApiError {
  constructor() {
    super(503, 'Processing is temporarily unavailable. Try again in a minute.', true, { code: 'QUEUE_UNAVAILABLE' });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Queue did not respond within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Adds a job for one record. If a job with the same id is still waiting or
 * running, nothing new is queued. A finished job with that id is removed first
 * so the record can be processed again (BullMQ would otherwise silently ignore
 * the add while the old job is kept).
 */
export async function enqueueJob(
  queue: QueueLike,
  name: string,
  data: Record<string, unknown>,
  options: JobsOptions & { jobId: string },
  { timeoutMs = 5000 }: { timeoutMs?: number } = {}
): Promise<{ id: string; deduplicated: boolean }> {
  try {
    return await withTimeout(
      (async () => {
        const existing = await queue.getJob(options.jobId);
        if (existing) {
          const state = await existing.getState();
          if (STILL_QUEUED.has(state)) return { id: options.jobId, deduplicated: true };
          await existing.remove().catch(() => undefined);
        }
        const job = await queue.add(name, data, options);
        return { id: String(job.id ?? options.jobId), deduplicated: false };
      })(),
      timeoutMs
    );
  } catch (error: any) {
    logger.error('Failed to enqueue job', { queue: name, jobId: options.jobId, error: error.message });
    throw new QueueUnavailableError();
  }
}

/**
 * Sets fields on a record only if its status is one of `from`. Returns the
 * updated record, or null if it had already moved on (e.g. was cancelled).
 */
export async function transition<T>(
  model: Model<T>,
  id: unknown,
  from: string[],
  set: Record<string, unknown>
): Promise<T | null> {
  return (await model.findOneAndUpdate({ _id: id, status: { $in: from } } as any, { $set: set }, { new: true })) as T | null;
}

/** True if this attempt is the last one BullMQ will make. */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}
