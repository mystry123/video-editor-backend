import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { isLottieFilesUrl, prepareLottie, stripExpressions } from '../src/services/lottie.service';
import { checkCalls } from '../src/services/ai/editorTools';

const storage = vi.hoisted(() => ({ uploaded: new Map<string, Buffer>() }));
vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return { ...actual, uploadBufferToS3: vi.fn(async (b: Buffer, key: string) => (storage.uploaded.set(key, b), `https://cdn.test/${key}`)) };
});

const anim = (extra: Record<string, unknown> = {}) => ({
  v: '5.7.4', fr: 30, ip: 0, op: 90, w: 512, h: 512, nm: 'Confetti burst',
  layers: [{ ty: 4, nm: 'shape', ks: { p: { a: 0, k: [256, 256], x: 'var $bm_rt = (function(){ fetch("https://evil.example") })()' }, o: { a: 0, k: 100 } } }],
  assets: [],
  ...extra,
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const fetched: string[] = [];
let served: Buffer = Buffer.from(JSON.stringify(anim()));
beforeEach(() => {
  fetched.length = 0;
  storage.uploaded.clear();
  served = Buffer.from(JSON.stringify(anim()));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (fetched.push(String(url)), new Response(new Uint8Array(served)))));
});
afterEach(() => vi.unstubAllGlobals());

describe('Lottie files', () => {
  it('accepts only LottieFiles asset links', () => {
    expect(isLottieFilesUrl('https://lottie.host/4db68bbd-31f6-4cd8-84eb-189de081159a/IGmMCqhzpt.json')).toBe(true);
    expect(isLottieFilesUrl('https://lottie.host/abc/xyz.lottie')).toBe(true);
    expect(isLottieFilesUrl('https://assets2.lottiefiles.com/packages/lf20_x.json')).toBe(true);
    expect(isLottieFilesUrl('http://lottie.host/a/b.json')).toBe(false);
    expect(isLottieFilesUrl('https://lottie.host.evil.com/a.json')).toBe(false);
    expect(isLottieFilesUrl('https://lottiefiles.com/free-animation/confetti-123')).toBe(false);
    expect(isLottieFilesUrl('https://169.254.169.254/a.json')).toBe(false);
  });

  it('removes expressions (code) but keeps separated x/y positions', () => {
    const data = anim();
    (data.layers[0] as any).ks.s = { x: { a: 0, k: 100 }, y: { a: 0, k: 100 } };
    expect(stripExpressions(data)).toBe(1);
    expect(JSON.stringify(data)).not.toContain('evil');
    expect((data.layers[0] as any).ks.s.x).toEqual({ a: 0, k: 100 });
  });

  it('unpacks a .lottie with its images inlined', () => {
    const json = anim({ assets: [{ id: 'img_0', w: 10, h: 10, u: '/images/', p: 'img_0.png', e: 0 }] });
    const zip = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify({ animations: [{ id: 'confetti' }] })), 'animations/confetti.json': strToU8(JSON.stringify(json)), 'images/img_0.png': new Uint8Array(PNG) }));
    const out = prepareLottie(zip);
    const data = JSON.parse(out.json.toString());
    expect(data.assets[0]).toMatchObject({ e: 1, u: '', p: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(out).toMatchObject({ width: 512, height: 512, fps: 30, duration: 3, name: 'Confetti burst' });
    expect(out.json.toString()).not.toContain('evil');
  });

  it('rejects files that are not Lottie', () => {
    expect(() => prepareLottie(Buffer.from('{"hello":1}'))).toThrow(/isn't a Lottie/);
    expect(() => prepareLottie(Buffer.from('not json'))).toThrow(/isn't a Lottie/);
    expect(() => prepareLottie(Buffer.from(zipSync({ 'readme.txt': strToU8('x') })))).toThrow(/isn't a Lottie/);
    expect(() => prepareLottie(Buffer.from(JSON.stringify(anim({ op: 0 }))))).toThrow(/isn't a Lottie/);
  });
});

describe('POST /files/import/lottie', () => {
  it('imports from a LottieFiles link, safely', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/files/import/lottie').set(user.auth).send({ url: 'https://lottie.host/abc/Confetti_Pop.json' });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'Confetti burst.json', mimeType: 'application/json', width: 512, height: 512, duration: 3 });
    expect(fetched).toEqual(['https://lottie.host/abc/Confetti_Pop.json']);
    const saved = [...storage.uploaded.values()][0].toString();
    expect(saved).not.toContain('evil');
    expect(await File.findById(res.body.file.fileId).lean()).toMatchObject({ source: 'lottie', status: 'ready', metadata: { duration: 3, width: 512, height: 512 } });
    const list = await api().get('/api/v1/files?type=lottie').set(user.auth);
    expect(JSON.stringify(list.body)).toContain('Confetti burst.json');
  });

  it('imports an uploaded file, named after the animation', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/files/import/lottie').set(user.auth).send({ data: Buffer.from(JSON.stringify(anim())).toString('base64') });
    expect(res.status).toBe(201);
    expect(res.body.file.name).toBe('Confetti burst.json');
    expect(fetched).toEqual([]);
  });

  it('refuses other links and bad files', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/files/import/lottie').set(user.auth).send({ url: 'https://example.com/a.json' })).status).toBe(400);
    expect(fetched).toEqual([]);
    expect((await api().post('/api/v1/files/import/lottie').set(user.auth).send({ data: Buffer.from('nope').toString('base64') })).status).toBe(422);
    expect((await api().post('/api/v1/files/import/lottie').set(user.auth).send({})).status).toBe(400);
    expect((await api().post('/api/v1/files/import/lottie').send({ url: 'https://lottie.host/a/b.json' })).status).toBe(401);
  });
});

describe('assistant add_lottie', () => {
  it('takes a name from the user\'s files or a LottieFiles link, not both', () => {
    const caps = { lottie: ['Confetti burst', 'Subscribe button'] };
    expect(checkCalls([{ name: 'add_lottie', args: { name: 'Confetti burst', at: 3 } }], caps).problems).toEqual([]);
    expect(checkCalls([{ name: 'add_lottie', args: { url: 'https://lottie.host/a/b.json', at: 0, position: 'top-right' } }], caps).problems).toEqual([]);
    expect(checkCalls([{ name: 'add_lottie', args: { name: 'Made up', at: 0 } }], caps).problems.length).toBe(1);
    expect(checkCalls([{ name: 'add_lottie', args: { at: 0 } }], caps).problems.length).toBe(1);
  });
});
