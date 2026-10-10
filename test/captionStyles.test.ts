import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { api, createUser } from './helpers';
import { CaptionPreset } from '../src/models/CaptionPreset';
import { CaptionPresetUse } from '../src/models/CaptionPresetUse';
import { CaptionCompositionService } from '../src/services/captioncomposition.service';
import { parseCaptionStyle, sanitizeStoredCaptionStyle } from '../src/schemas/captionStyle';

const style = {
  fontFamily: 'Montserrat',
  fontWeight: 900,
  fillColor: '#FFFFFF',
  highlightStyle: 'color',
  highlightColor: '#FFE600',
  strokeEnabled: true,
  strokeWidth: 6,
  strokeColor: '#000000',
  displayMode: 'tiktok',
  wordsPerLine: 3,
  textTransform: 'uppercase',
  wordAnimation: { type: 'caption-word-pop', duration: 0.3, easing: 'back-out', params: { startScale: '50%' } },
};

describe('caption style schema', () => {
  it('accepts a full style and stamps the version', () => {
    const result = parseCaptionStyle(style);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.style).toMatchObject({ ...style, schemaVersion: 1 });
  });

  it('rejects unsafe or out-of-range values', () => {
    for (const bad of [
      { fillColor: 'url(https://evil.example/x.png)' },
      { highlightColor: 'red;background:url(x)' },
      { fontFamily: 'Inter</style><script>' },
      { strokeWidth: 9999 },
      { displayMode: 'explode' },
      { wordAnimation: { type: 'caption-word-pop', duration: 0.3, params: { color: 'url(x)' } } },
      { wordAnimation: { type: 'nope', duration: 1 } },
    ]) {
      expect(parseCaptionStyle(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('drops unknown keys', () => {
    const result = parseCaptionStyle({ ...style, onclick: 'x', extra: 1 });
    expect(result.ok && 'onclick' in result.style).toBe(false);
  });

  it('stored styles keep their valid fields and lose only bad ones', () => {
    const clean = sanitizeStoredCaptionStyle({ fillColor: '#fff', highlightColor: 'url(x)', strokeWidth: 4, junk: 1 });
    expect(clean).toEqual({ fillColor: '#fff', strokeWidth: 4, schemaVersion: 1 });
  });
});

describe('caption presets API', () => {
  it('creates a validated preset; invalid styles are refused with the reason', async () => {
    const { auth } = await createUser({ role: 'pro' });
    const bad = await api().post('/api/v1/caption/presets').set(auth).send({ name: 'Bad', styles: { fillColor: 'url(x)' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message || bad.body.error?.message || JSON.stringify(bad.body)).toMatch(/fillColor/);

    const ok = await api().post('/api/v1/caption/presets').set(auth).send({ name: 'Mine', styles: { ...style, junk: 1 }, tags: ['bold'] });
    expect(ok.status).toBe(201);
    expect(ok.body.preset.styles).toMatchObject({ ...style, schemaVersion: 1 });
    expect(ok.body.preset.styles.junk).toBeUndefined();
  });

  it('updating a style replaces it (no stale fields left behind)', async () => {
    const { auth } = await createUser({ role: 'pro' });
    const created = await api().post('/api/v1/caption/presets').set(auth).send({ name: 'P', styles: style });
    const id = created.body.preset._id;
    const updated = await api().put(`/api/v1/caption/presets/${id}`).set(auth).send({ styles: { fontFamily: 'Inter', fillColor: '#000000' } });
    expect(updated.status).toBe(200);
    expect(updated.body.preset.styles.wordAnimation).toBeUndefined();
    expect(updated.body.preset.styles.fillColor).toBe('#000000');
  });

  it('counts a use once per user, preset and project, only for usable presets', async () => {
    const { auth } = await createUser();
    const other = await createUser({ role: 'pro' });
    const system = await CaptionPreset.create({ name: 'S', isSystem: true, styles: style });
    const privateOne = await CaptionPreset.create({ name: 'Priv', isSystem: false, userId: other.user._id, styles: style });

    expect((await api().post(`/api/v1/caption/presets/${system._id}/use`).set(auth).send({})).status).toBe(400);
    const first = await api().post(`/api/v1/caption/presets/${system._id}/use`).set(auth).send({ projectId: 'tpl1' });
    const again = await api().post(`/api/v1/caption/presets/${system._id}/use`).set(auth).send({ projectId: 'tpl1' });
    const otherProject = await api().post(`/api/v1/caption/presets/${system._id}/use`).set(auth).send({ projectId: 'tpl2' });
    expect([first.body.counted, again.body.counted, otherProject.body.counted]).toEqual([true, false, true]);
    expect((await CaptionPreset.findById(system._id))!.usageCount).toBe(2);
    expect(await CaptionPresetUse.countDocuments({ presetId: system._id })).toBe(2);

    expect((await api().post(`/api/v1/caption/presets/${privateOne._id}/use`).set(auth).send({ projectId: 'x' })).status).toBe(404);
  });
});

describe('caption composition', () => {
  const input = (settings: any, presetStyles: any = style) => ({
    videoUrl: 'https://cdn.test/v.mp4',
    videoFileId: String(new Types.ObjectId()),
    videoMetadata: { width: 1080, height: 1920, duration: 10, fps: 30 },
    transcription: { words: [{ word: 'hi', startMs: 0, endMs: 300 }], language: 'en' },
    preset: { styles: presetStyles } as any,
    settings,
  });
  const caption = async (settings: any, presetStyles?: any) =>
    (await CaptionCompositionService.generateDirect(input(settings, presetStyles) as any)).composition.elements.find((e: any) => e.type === 'caption') as any;

  it('uses the preset, then the editor style and position on top', async () => {
    const c = await caption({
      style: { highlightColor: '#00FF00', textTransform: 'lowercase', pageEnter: { type: 'caption-page-fade', duration: 0.2 } },
      placement: { y: '70%', width: '80%' },
    });
    expect(c).toMatchObject({
      fontFamily: 'Montserrat',
      strokeWidth: 6,
      highlightColor: '#00FF00',
      textTransform: 'lowercase',
      pageEnter: { type: 'caption-page-fade' },
      wordAnimation: { type: 'caption-word-pop' },
      y: '70%',
      width: '80%',
      x: '50%',
    });
    expect(c.schemaVersion).toBeUndefined();
  });

  it('older clients: single-field overrides still apply', async () => {
    expect((await caption({ highlightColor: '#123456', position: 'top' })).highlightColor).toBe('#123456');
  });

  it('a stored preset with a bad value keeps the rest of its look', async () => {
    const c = await caption({}, { ...style, highlightColor: 'url(x)' });
    expect(c.fontFamily).toBe('Montserrat');
    expect(c.highlightColor).toBeUndefined();
  });
});
