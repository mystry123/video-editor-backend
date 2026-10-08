import { describe, expect, it, vi } from 'vitest';
import { enqueueJob, isFinalAttempt, QueueUnavailableError, transition } from '../src/utils/jobs';
import { RenderJob } from '../src/models/RenderJob';
import { Template } from '../src/models/Template';
import { renderQueue } from '../src/queues';
import { api, createUser } from './helpers';

function queueWith(existingState?: string) {
  const existing = existingState ? { getState: vi.fn().mockResolvedValue(existingState), remove: vi.fn().mockResolvedValue(undefined) } : null;
  return {
    existing,
    queue: {
      add: vi.fn().mockResolvedValue({ id: 'new' }),
      getJob: vi.fn().mockResolvedValue(existing),
    },
  };
}

describe('enqueueJob', () => {
  it('does not queue a second job for a record that is still queued or running', async () => {
    for (const state of ['waiting', 'active', 'delayed', 'prioritized']) {
      const { queue } = queueWith(state);
      const result = await enqueueJob(queue, 'render', { jobId: 'r1' }, { jobId: 'render-r1' });
      expect(result).toEqual({ id: 'render-r1', deduplicated: true });
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('replaces a finished job so the record can be processed again', async () => {
    const { queue, existing } = queueWith('completed');
    const result = await enqueueJob(queue, 'render', { jobId: 'r1' }, { jobId: 'render-r1' });
    expect(existing!.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith('render', { jobId: 'r1' }, { jobId: 'render-r1' });
    expect(result.deduplicated).toBe(false);
  });

  it('fails fast with 503 when the queue does not answer', async () => {
    const hanging = { add: vi.fn(), getJob: vi.fn(() => new Promise(() => undefined)) };
    const started = Date.now();
    await expect(enqueueJob(hanging, 'render', {}, { jobId: 'x' }, { timeoutMs: 100 })).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('transition', () => {
  it('only moves a record from the expected states', async () => {
    const { user } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'cancelled' });
    expect(await transition(RenderJob, job._id, ['rendering'], { status: 'completed' })).toBeNull();
    expect((await RenderJob.findById(job._id))!.status).toBe('cancelled');

    await RenderJob.updateOne({ _id: job._id }, { status: 'rendering' });
    const moved: any = await transition(RenderJob, job._id, ['rendering'], { status: 'completed' });
    expect(moved.status).toBe('completed');
  });
});

describe('isFinalAttempt', () => {
  it('knows when BullMQ will not retry', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } } as any)).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } } as any)).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} } as any)).toBe(true);
  });
});

describe('when the queue is down', () => {
  it('a render request fails fast with 503 and the job is marked failed', async () => {
    const { user, auth } = await createUser();
    const t = await Template.create({ userId: user._id, name: 'T', data: { project: { width: 1280, height: 720, fps: 30, duration: 5 }, elements: [] } });
    (renderQueue.getJob as any).mockRejectedValueOnce(new Error('Connection is closed'));

    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('QUEUE_UNAVAILABLE');
    const job = await RenderJob.findOne({ userId: user._id });
    expect(job!.status).toBe('failed');
  });
});
