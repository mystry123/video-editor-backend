import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { env } from '../src/config/env';
import { reserveUsage, getMonthlyTotal } from '../src/services/usage.service';
import { checkRender, completeRender } from '../src/services/renderLifecycle.service';
import { checkRemotionProgress } from '../src/services/render.service';

vi.mock('../src/services/render.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/render.service')>();
  return { ...actual, checkRemotionProgress: vi.fn() };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

const SECRET = 'test-remotion-secret';
const sign = (body: unknown) => `sha512=${crypto.createHmac('sha512', SECRET).update(JSON.stringify(body)).digest('hex')}`;

async function renderingJob(extra: Record<string, unknown> = {}) {
  const { user } = await createUser();
  const job = await RenderJob.create({
    userId: user._id,
    inputProps: { project: { duration: 30 } },
    status: 'rendering',
    renderId: 'r-1',
    bucketName: 'b',
    startedAt: new Date(),
    ...extra,
  });
  await reserveUsage(user._id, 'renderMinutes', String(job._id), 30, -1);
  return { user, job };
}

const postWebhook = (body: Record<string, unknown>, signature = sign(body)) =>
  api().post('/api/v1/webhooks/remotion').set('X-Remotion-Signature', signature).send(body);

describe('Remotion webhook', () => {
  afterEach(() => {
    env.remotionWebhookSecret = '';
  });

  it("doesn't exist without a secret, and rejects bad signatures", async () => {
    expect((await postWebhook({ type: 'success' })).status).toBe(404);
    env.remotionWebhookSecret = SECRET;
    expect((await postWebhook({ type: 'success', customData: { jobId: 'x' } }, 'sha512=bad')).status).toBe(401);
  });

  it('completes and charges once, even when delivered twice', async () => {
    env.remotionWebhookSecret = SECRET;
    const { user, job } = await renderingJob();
    const body = { type: 'success', renderId: 'r-1', bucketName: 'b', customData: { jobId: String(job._id) }, outputUrl: 'https://cdn.test/renders/out.mp4' };
    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).status).toBe(200);
    const done = await RenderJob.findById(job._id);
    expect(done!.status).toBe('completed');
    expect(done!.outputUrl).toBe('https://cdn.test/renders/out.mp4');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it('matches by jobId when it arrives before renderId was saved', async () => {
    env.remotionWebhookSecret = SECRET;
    const { job } = await renderingJob({ renderId: undefined });
    const body = { type: 'success', renderId: 'r-early', bucketName: 'b', customData: { jobId: String(job._id) }, outputUrl: 'https://cdn.test/renders/o.mp4' };
    expect((await postWebhook(body)).status).toBe(200);
    const done = await RenderJob.findById(job._id);
    expect(done!.status).toBe('completed');
    expect(done!.renderId).toBe('r-early');
  });

  it('a render error fails the job with a safe message and refunds it', async () => {
    env.remotionWebhookSecret = SECRET;
    const { user, job } = await renderingJob();
    const body = { type: 'error', renderId: 'r-1', bucketName: 'b', customData: { jobId: String(job._id) }, errors: [{ message: 'arn:aws:lambda:... font load failed', name: 'E', stack: '' }] };
    expect((await postWebhook(body)).status).toBe(200);
    const failed = await RenderJob.findById(job._id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).not.toMatch(/arn:aws/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it("can't complete a cancelled render (no charge)", async () => {
    env.remotionWebhookSecret = SECRET;
    const { user, job } = await renderingJob();
    await RenderJob.updateOne({ _id: job._id }, { status: 'cancelled' });
    await postWebhook({ type: 'success', renderId: 'r-1', bucketName: 'b', customData: { jobId: String(job._id) }, outputUrl: 'https://cdn.test/x.mp4' });
    expect((await RenderJob.findById(job._id))!.status).toBe('cancelled');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30); // refund happens on cancel itself
  });
});

describe('checkRender', () => {
  it('fails a fatal render right away', async () => {
    const { job } = await renderingJob();
    vi.mocked(checkRemotionProgress).mockResolvedValueOnce({ done: false, progress: 0.2, fatalErrorEncountered: true, errors: [{ isFatal: true, message: 'timed out' }] } as any);
    expect(await checkRender(job)).toBe('failed');
    expect((await RenderJob.findById(job._id))!.error).toMatch(/took too long/);
  });

  it('saves progress while rendering and fails it after the deadline', async () => {
    const { job } = await renderingJob();
    vi.mocked(checkRemotionProgress).mockResolvedValue({ done: false, progress: 0.42 } as any);
    expect(await checkRender(job)).toBe('rendering');
    expect((await RenderJob.findById(job._id))!.progress).toBe(42);

    const old = { ...job.toObject(), startedAt: new Date(Date.now() - 31 * 60_000) };
    expect(await checkRender(old as any)).toBe('failed');
  });

  it('completeRender is a no-op for a job that already completed', async () => {
    const { job } = await renderingJob();
    expect(await completeRender(String(job._id), { outputUrl: 'https://cdn.test/a.mp4' })).toBe(true);
    expect(await completeRender(String(job._id), { outputUrl: 'https://cdn.test/b.mp4' })).toBe(false);
    expect((await RenderJob.findById(job._id))!.outputUrl).toBe('https://cdn.test/a.mp4');
  });
});

describe('status endpoint', () => {
  it('reads fresh progress for a rendering job', async () => {
    const { user, auth } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', renderId: 'r-9', bucketName: 'b', startedAt: new Date() });
    vi.mocked(checkRemotionProgress).mockResolvedValueOnce({ done: false, progress: 0.7 } as any);
    const res = await api().get(`/api/v1/render/${job._id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.progress).toBe(70);
  });
});
