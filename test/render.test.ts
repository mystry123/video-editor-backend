import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { RenderJob } from '../src/models/RenderJob';
import { User } from '../src/models/User';
import { renderQueue } from '../src/queues';

async function template(userId: unknown, project: Record<string, unknown>) {
  return Template.create({
    userId,
    name: 'T',
    data: { project: { fps: 30, outputFormat: 'mp4', ...project }, elements: [] },
  });
}

describe('POST /render', () => {
  it('takes duration from the template, not the request body', async () => {
    const { user, auth } = await createUser();
    const long = await template(user._id, { width: 1920, height: 1080, duration: 120 });
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(long._id), duration: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RENDER_MINUTES_EXCEEDED');
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it('downscales a vertical 1080p project to 720p on the free plan', async () => {
    const { user, auth } = await createUser();
    const t = await template(user._id, { width: 1080, height: 1920, duration: 10 });
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ resolution: '720p', downscaled: true }));
    const job = await RenderJob.findById(res.body.id);
    expect(job!.resolution).toBe('720p');
    expect(job!.scale).toBeCloseTo(720 / 1080, 5);
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
  });

  it('blocks instead when the user has the block policy', async () => {
    const { user, auth } = await createUser();
    await User.updateOne({ _id: user._id }, { $push: { planOverrides: { field: 'overResolution', value: 'block' } } });
    const t = await template(user._id, { width: 1920, height: 1080, duration: 10 });
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RESOLUTION_NOT_ALLOWED');
  });

  it('rejects unsupported formats and empty projects before queueing', async () => {
    const { user, auth } = await createUser();
    const png = await template(user._id, { width: 1280, height: 720, duration: 5, outputFormat: 'png' });
    expect((await api().post('/api/v1/render').set(auth).send({ templateId: String(png._id) })).status).toBe(422);
    const empty = await template(user._id, { width: 1280, height: 720, duration: 0 });
    expect((await api().post('/api/v1/render').set(auth).send({ templateId: String(empty._id) })).status).toBe(422);
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("can't render someone else's private template", async () => {
    const owner = await createUser();
    const other = await createUser();
    const t = await template(owner.user._id, { width: 1280, height: 720, duration: 5 });
    await Template.updateOne({ _id: t._id }, { isPublic: false });
    const res = await api().post('/api/v1/render').set(other.auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(404);
  });
});
