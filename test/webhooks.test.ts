import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { Webhook } from '../src/models/Webhook';
import { webhookQueue } from '../src/queues';
import { completeRender, failRender } from '../src/services/renderLifecycle.service';
import { deliverToUrl, deliverWebhook } from '../src/services/webhook.service';
import { safeRequest } from '../src/utils/safeRequest';

vi.mock('../src/utils/safeRequest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/safeRequest')>();
  return { ...actual, safeRequest: vi.fn() };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

async function renderWithWebhook() {
  const { user, auth } = await createUser();
  await Webhook.create({ userId: user._id, name: 'Hook', url: 'https://hooks.test/registered', events: ['render.completed', 'render.failed'], secret: 's', isActive: true });
  const job = await RenderJob.create({
    userId: user._id, inputProps: {}, status: 'rendering', webhookUrl: 'https://hooks.test/per-render',
  });
  return { user, auth, job };
}

describe('render notifications', () => {
  it('queue one delivery to the render URL and one per subscribed webhook, once', async () => {
    const { job } = await renderWithWebhook();
    await completeRender(String(job._id), { outputUrl: 'https://cdn.test/o.mp4' });
    await completeRender(String(job._id), { outputUrl: 'https://cdn.test/o.mp4' }); // duplicate: ignored
    const calls = vi.mocked(webhookQueue.add).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c: any[]) => c[1].url ?? 'registered')).toEqual(['https://hooks.test/per-render', 'registered']);
    expect(calls[0][1].payload.event).toBe('render.completed');
    expect(calls[0][1].payload.data.outputUrl).toMatch(/\/r\//);
    expect(new Set(calls.map((c: any[]) => c[2].jobId)).size).toBe(2);
  });

  it('send render.failed when a render fails', async () => {
    const { job } = await renderWithWebhook();
    await failRender(String(job._id), 'Nope', 'test');
    const events = vi.mocked(webhookQueue.add).mock.calls.map((c: any[]) => c[1].payload.event);
    expect(events).toEqual(['render.failed', 'render.failed']);
  });
});

describe('delivery', () => {
  it('signs per-render deliveries with the user secret and reports non-2xx as failure', async () => {
    const { user, auth } = await createUser();
    vi.mocked(safeRequest).mockResolvedValueOnce({ status: 500, data: 'boom' } as any);
    const result = await deliverToUrl(String(user._id), 'https://hooks.test/x', { event: 'render.completed', data: {} });
    expect(result).toMatchObject({ success: false, statusCode: 500 });

    const { body } = await api().get('/api/v1/webhooks/signing-secret').set(auth);
    const sent = vi.mocked(safeRequest).mock.calls[0][1] as any;
    const expected = crypto.createHmac('sha256', body.secret).update(sent.data).digest('hex');
    expect(sent.headers['X-Webhook-Signature']).toBe(expected);
  });

  it("doesn't throw for network errors on registered webhooks (the test endpoint shows them)", async () => {
    const { user } = await createUser();
    const webhook = await Webhook.create({ userId: user._id, name: 'Hook', url: 'https://hooks.test/r', events: ['test'], secret: 's', isActive: true });
    vi.mocked(safeRequest).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await deliverWebhook(String(webhook._id), { event: 'test' })).toMatchObject({ success: false, error: 'ECONNREFUSED' });
  });
});

describe('zapier poll', () => {
  it('reports failed renders instead of pending forever', async () => {
    const { user, auth } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'failed', error: 'Bad media' });
    const res = await api().get(`/api/v1/render/zapier/${job._id}/poll`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed', error: 'Bad media' });
  });
});
