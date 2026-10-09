import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { TemplateVersion } from '../src/models/TemplateVersion';
import { snapshotTemplate } from '../src/services/templateVersion.service';

const data = (text: string) => ({
  project: { name: 'Promo', width: 1080, height: 1920, duration: 12, fps: 30 },
  elements: [
    { id: 't', type: 'text', text },
    { id: 'v', type: 'video', time: 2, duration: 4 },
  ],
});

/** A template at version 3 with snapshots of versions 1 and 2. */
async function withHistory() {
  const owner = await createUser();
  const t = await Template.create({ userId: owner.user._id, name: 'T', data: data('v3'), version: 3 });
  await snapshotTemplate({ _id: t._id, version: 1, data: data('v1') }, owner.user._id, 'render');
  await snapshotTemplate({ _id: t._id, version: 2, data: data('v2') }, owner.user._id, 'leave');
  return { ...owner, t };
}
const restore = (auth: Record<string, string>, id: unknown, version: number, body?: Record<string, unknown>) =>
  api().post(`/api/v1/templates/${id}/restore/${version}`).set(auth).send(body);

describe('template version history', () => {
  it('lists full snapshots by default, newest 20', async () => {
    const { auth, user, t } = await withHistory();
    for (let v = 10; v < 40; v++) await snapshotTemplate({ _id: t._id, version: v, data: data(`v${v}`) }, user._id, 'render');
    const res = await api().get(`/api/v1/templates/${t._id}/versions`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe(3);
    expect(res.body.versions).toHaveLength(20);
    expect(res.body.versions[0].version).toBe(39);
    expect(res.body.versions[0].data.elements[0].text).toBe('v39');
  });

  it('?limit is capped at 50; ?summary=true leaves out data and adds cheap facts', async () => {
    const { auth, user, t } = await withHistory();
    for (let v = 10; v < 70; v++) await snapshotTemplate({ _id: t._id, version: v, data: data(`v${v}`) }, user._id, 'render');
    const all = await api().get(`/api/v1/templates/${t._id}/versions?limit=500&summary=true`).set(auth);
    expect(all.status).toBe(200);
    expect(all.body.versions).toHaveLength(50);
    const first = all.body.versions[0];
    expect(first.data).toBeUndefined();
    expect(first).toMatchObject({ version: 69, reason: 'render' });
    expect(first.summary).toMatchObject({ name: 'Promo', elementCount: 2, duration: 12, width: 1080, height: 1920 });
    expect(first.summary.size).toBeGreaterThan(50);

    const few = await api().get(`/api/v1/templates/${t._id}/versions?limit=2`).set(auth);
    expect(few.body.versions.map((v: any) => v.version)).toEqual([69, 68]);

    expect((await api().get(`/api/v1/templates/${t._id}/versions?limit=abc`).set(auth)).status).toBe(400);
  });

  it('summary duration falls back to where the last element ends', async () => {
    const { auth, user, t } = await withHistory();
    await snapshotTemplate(
      { _id: t._id, version: 5, data: { project: {}, elements: [{ time: 1, duration: 3 }, { time: '2', duration: 'x' }, 'junk'] } },
      user._id,
      'render'
    );
    await snapshotTemplate({ _id: t._id, version: 6, data: 'not an object' }, user._id, 'render');
    const res = await api().get(`/api/v1/templates/${t._id}/versions?summary=true`).set(auth);
    expect(res.status).toBe(200);
    const [six, five] = res.body.versions;
    expect(six.summary).toMatchObject({ elementCount: 0, duration: 0, size: 0, name: null, width: null });
    expect(five.summary).toMatchObject({ elementCount: 3, duration: 4 });
  });

  it('returns one version with its data, to the owner only', async () => {
    const { auth, t } = await withHistory();
    const res = await api().get(`/api/v1/templates/${t._id}/versions/2`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe(3);
    expect(res.body.version).toMatchObject({ version: 2, reason: 'leave' });
    expect(res.body.version.data.elements[0].text).toBe('v2');

    const missing = await api().get(`/api/v1/templates/${t._id}/versions/9`).set(auth);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('VERSION_NOT_FOUND');
    expect((await api().get(`/api/v1/templates/${t._id}/versions/x`).set(auth)).status).toBe(400);

    const other = await createUser();
    expect((await api().get(`/api/v1/templates/${t._id}/versions/2`).set(other.auth)).status).toBe(404);
    expect((await api().get(`/api/v1/templates/${t._id}/versions`).set(other.auth)).status).toBe(404);
  });

  it('restore keeps the replaced state as before-restore and returns the new version', async () => {
    const { auth, t } = await withHistory();
    const res = await restore(auth, t._id, 1, { baseVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, version: 4, restoredFrom: 1 });

    const after = await Template.findById(t._id).lean();
    expect(after!.version).toBe(4);
    expect((after!.data as any).elements[0].text).toBe('v1');
    const kept = await TemplateVersion.findOne({ templateId: t._id, version: 3 }).lean();
    expect(kept).toMatchObject({ reason: 'before-restore' });
    expect(kept!.data.elements[0].text).toBe('v3');
  });

  it('restore works when the current version already has a snapshot', async () => {
    const { auth, user, t } = await withHistory();
    await snapshotTemplate({ _id: t._id, version: 3, data: data('v3') }, user._id, 'render');
    const res = await restore(auth, t._id, 2);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(4);
    // The existing snapshot of version 3 is kept as it was.
    expect(await TemplateVersion.findOne({ templateId: t._id, version: 3 }).lean()).toMatchObject({ reason: 'render' });
    // And restoring again (now from version 4) still works.
    expect((await restore(auth, t._id, 1, { baseVersion: 4 })).body.version).toBe(5);
  });

  it('restore returns 409 VERSION_CONFLICT for a stale base version and changes nothing', async () => {
    const { auth, t } = await withHistory();
    const res = await restore(auth, t._id, 1, { baseVersion: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.details).toMatchObject({ currentVersion: 3, baseVersion: 2 });
    const after = await Template.findById(t._id).lean();
    expect(after!.version).toBe(3);
    expect(await TemplateVersion.countDocuments({ templateId: t._id })).toBe(2);
  });

  it('restore 404s for a missing version or someone else\'s template', async () => {
    const { auth, t } = await withHistory();
    const missing = await restore(auth, t._id, 9);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('VERSION_NOT_FOUND');
    const other = await createUser();
    expect((await restore(other.auth, t._id, 1)).status).toBe(404);
    expect((await Template.findById(t._id).lean())!.version).toBe(3);
  });
});
