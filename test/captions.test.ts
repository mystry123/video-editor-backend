import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { api, createUser } from './helpers';
import { CaptionProject } from '../src/models/Caption';
import { CaptionPreset } from '../src/models/CaptionPreset';
import { RenderJob } from '../src/models/RenderJob';
import { reserveUsage, getMonthlyTotal } from '../src/services/usage.service';
import { seedCaptionPresets } from '../src/seeds/caption-presets.seed';

async function project(userId: unknown, extra: Record<string, unknown> = {}) {
  return CaptionProject.create({ userId, fileId: new Types.ObjectId(), name: 'c', status: 'rendering', ...extra });
}

describe('caption projects', () => {
  it('cancel stops the render and refunds the reserved minutes and export', async () => {
    const { user, auth } = await createUser();
    const render = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', renderType: 'CaptionProject' });
    const p = await project(user._id, { renderJobId: render._id });
    await reserveUsage(user._id, 'captionRenderMinutes', `caption-render-${p._id}`, 60, 5);
    await reserveUsage(user._id, 'captionExports', `caption-export-${p._id}`, 1, 3);

    const res = await api().post(`/api/v1/caption/projects/${p._id}/cancel`).set(auth);
    expect(res.status).toBe(200);
    expect((await CaptionProject.findById(p._id))!.status).toBe('failed');
    expect((await RenderJob.findById(render._id))!.status).toBe('cancelled');
    expect(await getMonthlyTotal(String(user._id), 'captionRenderMinutes')).toBe(0);
    expect(await getMonthlyTotal(String(user._id), 'captionExports')).toBe(0);

    // A second cancel finds nothing active.
    expect((await api().post(`/api/v1/caption/projects/${p._id}/cancel`).set(auth)).status).toBe(404);
  });

  it('changing the preset drops the stored composition, and is refused once rendering', async () => {
    const { user, auth } = await createUser();
    const preset = await CaptionPreset.create({ name: 'P', isSystem: true, styles: { fontFamily: 'Inter', fontWeight: 700 }, previewStyles: { highlightColor: '#ff0', textColor: '#fff', fontFamily: 'Inter' } });
    const generating = await project(user._id, { status: 'generating', composition: { project: {} } });
    const ok = await api().patch(`/api/v1/caption/projects/${generating._id}/preset`).set(auth).send({ presetId: String(preset._id) });
    expect(ok.status).toBe(200);
    expect((await CaptionProject.findById(generating._id).select('+composition').lean())!.composition).toBeUndefined();

    const rendering = await project(user._id);
    expect((await api().patch(`/api/v1/caption/projects/${rendering._id}/preset`).set(auth).send({ presetId: String(preset._id) })).status).toBe(400);
  });
});

describe('caption presets', () => {
  it('the seed upserts by slug, keeps wordsPerLine and marks one default', async () => {
    await seedCaptionPresets();
    await seedCaptionPresets();
    const system = await CaptionPreset.find({ isSystem: true }).lean();
    expect(new Set(system.map((p) => p.slug)).size).toBe(system.length);
    expect(system.filter((p) => p.isDefault)).toHaveLength(1);
    expect(system.some((p) => typeof (p.styles as any).wordsPerLine === 'number')).toBe(true);
  });

  it('the unauthenticated /caption-presets router is gone; /caption/presets needs a session', async () => {
    expect((await api().get('/api/v1/caption-presets')).status).toBe(404);
    expect((await api().get('/api/v1/caption/presets')).status).toBe(401);
    const { auth } = await createUser();
    expect((await api().get('/api/v1/caption/presets').set(auth)).status).toBe(200);
  });
});
