import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { reserveUsage, getMonthlyTotal } from '../src/services/usage.service';
import { RENDER_DEADLINE_MS, checkRender, completeRender, describeRenderError, failRender } from '../src/services/renderLifecycle.service';

vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

async function renderingJob(extra: Record<string, unknown> = {}) {
  const { user } = await createUser();
  const job = await RenderJob.create({
    userId: user._id,
    inputProps: { project: { duration: 30 } },
    status: 'rendering',
    renderId: 'local-test-1',
    startedAt: new Date(),
    ...extra,
  });
  await reserveUsage(user._id, 'renderMinutes', String(job._id), 30, -1);
  return { user, job };
}

describe('completeRender / failRender', () => {
  it('completes and charges once, even when called twice', async () => {
    const { user, job } = await renderingJob();
    expect(await completeRender(String(job._id), { outputUrl: 'https://cdn.test/a.mp4' })).toBe(true);
    expect(await completeRender(String(job._id), { outputUrl: 'https://cdn.test/b.mp4' })).toBe(false);
    expect((await RenderJob.findById(job._id))!.outputUrl).toBe('https://cdn.test/a.mp4');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it("can't complete a cancelled render (no charge)", async () => {
    const { user, job } = await renderingJob();
    await RenderJob.updateOne({ _id: job._id }, { status: 'cancelled' });
    expect(await completeRender(String(job._id), { outputUrl: 'https://cdn.test/x.mp4' })).toBe(false);
    expect((await RenderJob.findById(job._id))!.status).toBe('cancelled');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30); // refund happens on cancel itself
  });

  it('a failure refunds it, once', async () => {
    const { user, job } = await renderingJob();
    expect(await failRender(String(job._id), 'nope', 'render_failed')).toBe(true);
    expect(await failRender(String(job._id), 'nope', 'render_failed')).toBe(false);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('shows users safe messages, never paths or stack frames', () => {
    expect(describeRenderError('Error at /var/www/shotline/backend/x.js: font "Foo" failed')).not.toMatch(/var\/www/);
    expect(describeRenderError('net::ERR_NAME_NOT_RESOLVED https://x/a.mp4')).toMatch(/media file/);
    expect(describeRenderError('Remotion bundle not found at /x')).toMatch(/temporarily unavailable/);
    expect(describeRenderError('A delayRender() timed out')).toMatch(/took too long/);
  });
});

describe('checkRender (backstop for a dead worker)', () => {
  it('leaves a render alone within its deadline', async () => {
    const { job } = await renderingJob();
    expect(await checkRender(job)).toBe('rendering');
    expect((await RenderJob.findById(job._id))!.status).toBe('rendering');
  });

  it('fails and refunds one well past its deadline', async () => {
    const { user, job } = await renderingJob({ startedAt: new Date(Date.now() - RENDER_DEADLINE_MS - 6 * 60_000) });
    expect(await checkRender(job)).toBe('failed');
    expect((await RenderJob.findById(job._id))!.error).toMatch(/took too long/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('ignores jobs that already ended', async () => {
    const { job } = await renderingJob({ status: 'completed' });
    expect(await checkRender(job)).toBe('ended');
  });
});

describe('status endpoint', () => {
  it('returns the progress the worker saved', async () => {
    const { user, auth } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', renderId: 'local-x', progress: 70, startedAt: new Date() });
    const res = await api().get(`/api/v1/render/${job._id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.progress).toBe(70);
    expect(res.body.status).toBe('rendering');
  });
});
