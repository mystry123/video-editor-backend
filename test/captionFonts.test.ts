import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { api, createUser } from './helpers';
import { CaptionPreset } from '../src/models/CaptionPreset';
import { File } from '../src/models/File';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    createPresignedUpload: vi.fn(async ({ key }: { key: string }) => ({ url: 'https://s3.test/', fields: { key } })),
  };
});

const fontUpload = (name = 'Brand.woff2') => ({ filename: name, mimeType: 'font/woff2', size: 20_000 });
const fontUrl = (userId: unknown, host = 'https://cdn.test') => `${host}/users/${userId}/uploads/${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.woff2`;

describe('custom fonts', () => {
  it('free plans cannot upload fonts; paid plans can, up to their limit', async () => {
    const free = await createUser();
    const denied = await api().post('/api/v1/files/upload-url').set(free.auth).send(fontUpload());
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toMatch(/CUSTOM_FONTS_NOT_ALLOWED/);

    const pro = await createUser({ role: 'pro' });
    const ok = await api().post('/api/v1/files/upload-url').set(pro.auth).send(fontUpload());
    expect(ok.status).toBe(200);

    // pro: 10 fonts; fill the rest
    for (let i = 1; i < 10; i++) {
      await File.create({ userId: pro.user._id, name: `f${i}`, originalName: `f${i}`, mimeType: 'application/octet-stream', size: 1, storageKey: `users/${pro.user._id}/uploads/x${i}.ttf`, cdnUrl: 'x', status: 'ready', source: 'upload' });
    }
    const full = await api().post('/api/v1/files/upload-url').set(pro.auth).send(fontUpload('More.ttf'));
    expect(full.status).toBe(403);
    expect(JSON.stringify(full.body)).toMatch(/CUSTOM_FONT_LIMIT_REACHED/);

    // Videos are unaffected
    expect((await api().post('/api/v1/files/upload-url').set(free.auth).send({ filename: 'v.mp4', mimeType: 'video/mp4', size: 1000 })).status).toBe(200);
  });

  it('font listing finds fonts uploaded without a font type', async () => {
    const pro = await createUser({ role: 'pro' });
    await File.create({ userId: pro.user._id, name: 'a', originalName: 'a', mimeType: 'application/octet-stream', size: 1, storageKey: `users/${pro.user._id}/uploads/a.woff2`, cdnUrl: 'x', status: 'ready', source: 'upload' });
    const res = await api().get('/api/v1/files?type=font').set(pro.auth);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/a\.woff2/);
  });

  it('a style may only use a font on our media CDN', async () => {
    const pro = await createUser({ role: 'pro' });
    const styles = (url: string) => ({ fontFamily: 'sl-brand', fontUrl: url, fillColor: '#ffffff' });
    const elsewhere = await api().post('/api/v1/caption/presets').set(pro.auth).send({ name: 'A', styles: styles(fontUrl(pro.user._id, 'https://evil.example')) });
    expect(elsewhere.status).toBe(400);
    const notAFont = await api().post('/api/v1/caption/presets').set(pro.auth).send({ name: 'B', styles: styles('https://cdn.test/fonts/x.js') });
    expect(notAFont.status).toBe(400);
    const ours = await api().post('/api/v1/caption/presets').set(pro.auth).send({ name: 'C', styles: styles(fontUrl(pro.user._id)) });
    expect(ours.status).toBe(201);
  });

  it('the list marks own styles and hides other owners', async () => {
    const me = await createUser({ role: 'pro' });
    const other = await createUser({ role: 'pro' });
    await CaptionPreset.create({ name: 'Mine', isSystem: false, userId: me.user._id, styles: { fillColor: '#fff' } });
    await CaptionPreset.create({ name: 'Theirs', isSystem: false, isPublic: true, userId: other.user._id, styles: { fillColor: '#fff' } });
    const res = await api().get('/api/v1/caption/presets').set(me.auth);
    const byName = Object.fromEntries(res.body.presets.map((p: any) => [p.name, p]));
    expect(byName.Mine.isOwn).toBe(true);
    expect(byName.Theirs.isOwn).toBe(false);
    expect(byName.Theirs.userId).toBeUndefined();
    expect(String(byName.Mine.userId)).toBe(String(me.user._id));
    expect(new Types.ObjectId(String(byName.Mine._id))).toBeTruthy();
  });
});
