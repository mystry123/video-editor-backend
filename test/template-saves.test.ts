import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { TemplateVersion } from '../src/models/TemplateVersion';
import { KEEP_VERSIONS, snapshotTemplate } from '../src/services/templateVersion.service';

const data = { project: { width: 1280, height: 720, duration: 5, fps: 30 }, elements: [{ id: 't', type: 'text', text: 'a' }] };

async function owned() {
  const owner = await createUser();
  const t = await Template.create({ userId: owner.user._id, name: 'T', data });
  return { ...owner, t };
}
const save = (auth: Record<string, string>, id: unknown, body: Record<string, unknown>, query = '') =>
  api().put(`/api/v1/templates/${id}${query}`).set(auth).send({ data, ...body });

describe('template saves', () => {
  it('autosave snapshots at most once per 5 minutes; leave always does', async () => {
    const { auth, t } = await owned();
    await save(auth, t._id, {});
    await save(auth, t._id, {});
    await save(auth, t._id, {});
    expect(await TemplateVersion.countDocuments({ templateId: t._id })).toBe(1);
    await save(auth, t._id, { snapshot: 'leave' });
    const versions = await TemplateVersion.find({ templateId: t._id }).lean();
    expect(versions.map((v) => v.reason)).toEqual(['autosave', 'leave']);
  });

  it('returns 409 VERSION_CONFLICT for a stale base version, unless overwriting', async () => {
    const { auth, t } = await owned();
    expect((await save(auth, t._id, { baseVersion: 1 })).status).toBe(200); // now version 2
    const stale = await save(auth, t._id, { baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.details).toMatchObject({ currentVersion: 2 });
    const forced = await save(auth, t._id, { baseVersion: 1, overwrite: true });
    expect(forced.status).toBe(200);
    expect(forced.body.version).toBe(3);
  });

  it('minimal replies carry only the new version', async () => {
    const { auth, t } = await owned();
    const res = await save(auth, t._id, {}, '?return=minimal');
    expect(Object.keys(res.body).sort()).toEqual(['id', 'updatedAt', 'version']);
    expect(res.body.version).toBe(2);
  });

  it('keeps only the latest 50 snapshots', async () => {
    const { user, t } = await owned();
    for (let v = 1; v <= KEEP_VERSIONS + 5; v++) {
      await snapshotTemplate({ _id: t._id, version: v, data }, user._id, 'render');
    }
    const versions = await TemplateVersion.find({ templateId: t._id }).sort({ version: 1 }).lean();
    expect(versions).toHaveLength(KEEP_VERSIONS);
    expect(versions[0].version).toBe(6);
  });
});
