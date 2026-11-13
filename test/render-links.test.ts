import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { CaptionProject } from '../src/models';
import { completeRender } from '../src/services/renderLifecycle.service';
import { parseStorageUrl } from '../src/services/renderOutput.service';

// GCS: signed URLs and deletes of render outputs
const gcsSign = vi.hoisted(() => vi.fn(async (bucket: string, key: string, config: any) => [`https://signed.test/${bucket}/${key}?disposition=${config.responseDisposition ?? ''}`]));
const gcsDelete = vi.hoisted(() => vi.fn(async (_bucket: string, _key: string) => [{}]));
vi.mock('../src/config/gcs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/gcs')>();
  const fake = {
    bucket: (bucket: string) => ({
      file: (key: string) => ({
        getSignedUrl: (config: any) => gcsSign(bucket, key, config),
        delete: () => gcsDelete(bucket, key),
      }),
    }),
  };
  return { ...actual, gcs: () => fake };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

const OUTPUT = 'https://storage.googleapis.com/test-renders/renders/r1/u/j.mp4';
// Made on Remotion Lambda before the move to GCP: that AWS account is gone.
const LAMBDA_OUTPUT = 'https://remotionlambda-test.s3.ap-south-1.amazonaws.com/renders/r1/renders/u/j.mp4';

async function completedRender(outputUrl = OUTPUT) {
  const { user, auth } = await createUser();
  const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'completed', outputUrl, outputFormat: 'mp4' });
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
    expect(body).not.toContain('storage.googleapis.com');
    expect(body).not.toContain('shareToken');
  });

  it('/r/:id redirects to a signed URL with the right token, and 404s otherwise', async () => {
    const { job, token } = await completedRender();
    const ok = await api().get(`/r/${job._id}?t=${encodeURIComponent(token)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/^https:\/\/signed\.test\/test-renders\/renders\/r1\/u\/j\.mp4/);

    const download = await api().get(`/r/${job._id}?t=${encodeURIComponent(token)}&download=1`);
    expect(decodeURIComponent(download.headers.location)).toContain('attachment; filename="shotline-');

    expect((await api().get(`/r/${job._id}?t=wrong`)).status).toBe(404);
    expect((await api().get(`/r/${job._id}`)).status).toBe(404);
    expect((await api().get('/r/not-an-id?t=x')).status).toBe(404);
  });

  it("old renders made on Remotion Lambda (S3) can't be signed any more", async () => {
    const { job, token } = await completedRender(LAMBDA_OUTPUT);
    gcsSign.mockClear();
    const res = await api().get(`/r/${job._id}?t=${encodeURIComponent(token)}`);
    expect(res.status).not.toBe(302);
    expect(gcsSign).not.toHaveBeenCalled();
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
    gcsDelete.mockClear();
    expect(await completeRender(String(job._id), { outputUrl: OUTPUT })).toBe(false);
    expect(gcsDelete).toHaveBeenCalledTimes(1);
    expect(gcsDelete).toHaveBeenCalledWith('test-renders', 'renders/r1/u/j.mp4');

  });

  it("the projects list links a caption project to its render's output", async () => {
    const { user, auth, job, token } = await completedRender();
    await RenderJob.updateOne({ _id: job._id }, { thumbnailUrl: 'https://cdn.test/thumb.jpg' });
    const project = await CaptionProject.create({
      userId: user._id, fileId: user._id, name: 'My captions', status: 'completed', renderJobId: job._id, outputUrl: OUTPUT,
    } as any);
    const link = `http://localhost:3000/r/${job._id}?t=${token}`;
    const list = await api().get('/api/v1/projects').set(auth);
    expect(list.body.data[0]).toMatchObject({ _id: String(project._id), name: 'My captions', outputUrl: link, thumbnailUrl: 'https://cdn.test/thumb.jpg' });
    const one = await api().get(`/api/v1/projects/${project._id}`).set(auth);
    expect(one.body).toMatchObject({ name: 'My captions', outputUrl: link });
  });

  it('parses GCS URLs; S3 ones are not ours any more', () => {
    expect(parseStorageUrl(OUTPUT)).toEqual({ bucket: 'test-renders', key: 'renders/r1/u/j.mp4' });
    expect(parseStorageUrl('https://test-renders.storage.googleapis.com/a/b.mp4')).toEqual({ bucket: 'test-renders', key: 'a/b.mp4' });
    expect(parseStorageUrl('gs://test-renders/a/b.mp4')).toEqual({ bucket: 'test-renders', key: 'a/b.mp4' });
    expect(parseStorageUrl('https://storage.googleapis.com/only-bucket')).toBeNull();
    expect(parseStorageUrl(LAMBDA_OUTPUT)).toBeNull();
  });
});
