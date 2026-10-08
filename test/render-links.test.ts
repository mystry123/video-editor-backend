import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { completeRender } from '../src/services/renderLifecycle.service';
import { parseS3Url } from '../src/services/renderOutput.service';

const presign = vi.hoisted(() => vi.fn(async (_client: unknown, command: any) => `https://signed.test/${command.input.Key}?disposition=${command.input.ResponseContentDisposition ?? ''}`));
const s3Send = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: presign }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class FakeS3 {
    send = s3Send;
  }
  return { ...actual, S3Client: FakeS3 };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

const OUTPUT = 'https://remotionlambda-test.s3.ap-south-1.amazonaws.com/renders/r1/renders/u/j.mp4';

async function completedRender() {
  const { user, auth } = await createUser();
  const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'completed', outputUrl: OUTPUT, outputFormat: 'mp4' });
  const token = ((await RenderJob.findById(job._id).select('+shareToken').lean()) as any).shareToken as string;
  return { user, auth, job, token };
}

describe('render links', () => {
  it('the status endpoint returns a Shotline link, never the bucket or internal fields', async () => {
    const { auth, job, token } = await completedRender();
    const res = await api().get(`/api/v1/render/${job._id}`).set(auth);
    expect(res.body.outputUrl).toBe(`http://localhost:3000/r/${job._id}?t=${token}`);
    expect(res.body.downloadUrl).toBe(`${res.body.outputUrl}&download=1`);
    const list = await api().get('/api/v1/render').set(auth);
    const body = JSON.stringify(list.body);
    expect(body).not.toContain('amazonaws.com');
    expect(body).not.toContain('shareToken');
  });

  it('/r/:id redirects to a signed URL with the right token, and 404s otherwise', async () => {
    const { job, token } = await completedRender();
    const ok = await api().get(`/r/${job._id}?t=${encodeURIComponent(token)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/^https:\/\/signed\.test\/renders\/r1\/renders\/u\/j\.mp4/);

    const download = await api().get(`/r/${job._id}?t=${encodeURIComponent(token)}&download=1`);
    expect(decodeURIComponent(download.headers.location)).toContain('attachment; filename="shotline-');

    expect((await api().get(`/r/${job._id}?t=wrong`)).status).toBe(404);
    expect((await api().get(`/r/${job._id}`)).status).toBe(404);
    expect((await api().get('/r/not-an-id?t=x')).status).toBe(404);
  });

  it('gives renders made before links existed a token on first read', async () => {
    const { auth, job } = await completedRender();
    await RenderJob.collection.updateOne({ _id: job._id }, { $unset: { shareToken: '' } });
    const first = await api().get(`/api/v1/render/${job._id}`).set(auth);
    const second = await api().get(`/api/v1/render/${job._id}`).set(auth);
    expect(first.body.outputUrl).toMatch(/\?t=[\w-]{20,}$/);
    expect(second.body.outputUrl).toBe(first.body.outputUrl);
  });

  it('deletes the file of a render that finishes after it was cancelled', async () => {
    const { user } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'cancelled' });
    s3Send.mockClear();
    expect(await completeRender(String(job._id), { outputUrl: OUTPUT })).toBe(false);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect((s3Send.mock.calls[0] as any[])[0].input).toEqual({ Bucket: 'remotionlambda-test', Key: 'renders/r1/renders/u/j.mp4' });
  });

  it('parses both S3 URL styles', () => {
    expect(parseS3Url(OUTPUT)).toEqual({ bucket: 'remotionlambda-test', key: 'renders/r1/renders/u/j.mp4' });
    expect(parseS3Url('https://s3.ap-south-1.amazonaws.com/b/k/x.mp4')).toEqual({ bucket: 'b', key: 'k/x.mp4' });
    expect(parseS3Url('https://cdn.test/x.mp4')).toBeNull();
  });
});
