// The render worker: renders on this server (the renderer itself is faked),
// uploads, and completes/fails through the lifecycle service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { getMonthlyTotal, reserveUsage } from '../src/services/usage.service';

vi.mock('../src/utils/worker.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/worker.utils')>();
  return { ...actual, createWorker: vi.fn(() => ({})) };
});
vi.mock('../src/services/render.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/render.service')>();
  return {
    ...actual,
    resolveServeUrl: vi.fn().mockResolvedValue('/srv/bundles/abc'),
    renderVideo: vi.fn(),
    uploadRenderOutput: vi.fn(),
    closeBrowser: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

const { processRenderJob, renderTimings } = await import('../src/workers/render.worker');
const render = await import('../src/services/render.service');
const OUTPUT = 'https://storage.googleapis.com/test-renders/renders/u/j.mp4';

async function queuedJob(extra: Record<string, unknown> = {}) {
  const { user } = await createUser();
  const job = await RenderJob.create({
    userId: user._id,
    inputProps: { project: { duration: 30, fps: 30, width: 1080, height: 1920 }, elements: [{ id: 'e1' }] },
    outputFormat: 'mp4',
    status: 'queued',
    ...extra,
  });
  await reserveUsage(user._id, 'renderMinutes', String(job._id), 30, -1);
  return { user, job };
}

const run = (jobId: unknown) => processRenderJob({ data: { jobId: String(jobId) }, attemptsMade: 0 } as any);

/** A renderVideo that only ends when cancelled */
const renderUntilCancelled = () =>
  vi.mocked(render.renderVideo).mockImplementation(
    (opts) => new Promise((_, reject) => opts.cancelSignal?.(() => reject(new Error('renderMedia() got cancelled'))))
  );

beforeEach(() => {
  Object.assign(renderTimings, { progressEveryMs: 0, watchEveryMs: 30 });
  vi.mocked(render.uploadRenderOutput).mockResolvedValue(OUTPUT);
});
afterEach(() => {
  Object.assign(renderTimings, { progressEveryMs: 2000, watchEveryMs: 5000, deadlineMs: 45 * 60_000 });
  vi.mocked(render.renderVideo).mockReset();
});

describe('render worker', () => {
  it('renders the saved project, uploads it, completes and charges it', async () => {
    const { user, job } = await queuedJob();
    vi.mocked(render.renderVideo).mockImplementation(async (opts) => {
      opts.onProgress?.({ progress: 0.5, renderedFrames: 450, encodedFrames: 400, stage: 'encoding' });
      return { outputPath: opts.outputPath, frames: 900, sizeBytes: 1234 };
    });

    expect(await run(job._id)).toEqual({ completed: true });

    const opts = vi.mocked(render.renderVideo).mock.calls[0][0];
    expect(opts).toMatchObject({ serveUrl: '/srv/bundles/abc', outputFormat: 'mp4', elements: [{ id: 'e1' }] });
    expect(opts.project).toMatchObject({ duration: 30, fps: 30 });
    const done = await RenderJob.findById(job._id).select('+outputBucket +outputKey +serveUrl');
    expect(done).toMatchObject({ status: 'completed', progress: 100, outputUrl: OUTPUT, outputBucket: 'test-renders', outputKey: 'renders/u/j.mp4', serveUrl: '/srv/bundles/abc' });
    expect(done!.renderId).toMatch(/^local-/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it('saves progress while rendering, never 100 before it is done', async () => {
    const { job } = await queuedJob();
    let seen: number | undefined;
    vi.mocked(render.renderVideo).mockImplementation(async (opts) => {
      opts.onProgress?.({ progress: 1, renderedFrames: 900, encodedFrames: 900, stage: 'done' });
      await new Promise((r) => setTimeout(r, 50));
      seen = (await RenderJob.findById(job._id))!.progress;
      return { outputPath: opts.outputPath, frames: 900, sizeBytes: 1 };
    });
    await run(job._id);
    expect(seen).toBe(99);
  });

  it('stops when the job is cancelled: nothing uploaded, nothing charged', async () => {
    const { user, job } = await queuedJob();
    renderUntilCancelled();
    const running = run(job._id);
    await new Promise((r) => setTimeout(r, 60));
    await RenderJob.updateOne({ _id: job._id }, { status: 'cancelled' });

    expect(await running).toEqual({ cancelled: true });
    expect(render.uploadRenderOutput).not.toHaveBeenCalled();
    expect((await RenderJob.findById(job._id))!.status).toBe('cancelled');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30); // refunded by the cancel itself, not here
  });

  it('fails and refunds a render that passes the deadline', async () => {
    const { user, job } = await queuedJob();
    renderTimings.deadlineMs = 50;
    renderUntilCancelled();

    expect(await run(job._id)).toEqual({ failed: 'timeout' });
    const failed = await RenderJob.findById(job._id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toMatch(/took too long/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('fails a broken project with a safe message (no retry), and refunds it', async () => {
    const { user, job } = await queuedJob();
    vi.mocked(render.renderVideo).mockRejectedValue(new Error('Error loading /home/shotline/x: font "Foo" could not be loaded'));

    expect(await run(job._id)).toEqual({ failed: true });
    const failed = await RenderJob.findById(job._id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).not.toMatch(/home\/shotline/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('says rendering is unavailable (not "your media") when the bundle is missing', async () => {
    const { job } = await queuedJob();
    vi.mocked(render.resolveServeUrl).mockRejectedValueOnce(new Error('Remotion bundle not found at /srv/bundles/current (deploy the frontend to build it)'));
    await run(job._id);
    expect((await RenderJob.findById(job._id))!.error).toMatch(/temporarily unavailable/);
  });

  it('restarts the browser after Chrome crashed', async () => {
    const { job } = await queuedJob();
    vi.mocked(render.renderVideo).mockRejectedValue(new Error('Protocol error (Runtime.callFunctionOn): Target closed'));
    await run(job._id);
    expect(render.closeBrowser).toHaveBeenCalled();
  });

  it('starts over a render whose worker died, and skips finished jobs', async () => {
    const { job } = await queuedJob({ status: 'rendering', renderId: 'local-old-1', progress: 40 });
    vi.mocked(render.renderVideo).mockImplementation(async (opts) => ({ outputPath: opts.outputPath, frames: 900, sizeBytes: 1 }));
    expect(await run(job._id)).toEqual({ completed: true });
    expect((await RenderJob.findById(job._id))!.renderId).not.toBe('local-old-1');

    expect(await run(job._id)).toEqual({ skipped: true, reason: 'completed' });
  });
});
