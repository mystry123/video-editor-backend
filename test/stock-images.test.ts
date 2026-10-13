import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { UsageEntry as Usage } from '../src/models/Usage';
import { env } from '../src/config/env';
import { checkCalls } from '../src/services/ai/editorTools';
import { clearStockCache, isPixabayFileUrl } from '../src/services/stock.service';
import { setImageGenerator } from '../src/services/ai/imageGen';
import { sniffMedia } from '../src/controllers/stock.controller';
import { imageSize } from '../src/controllers/aiImage.controller';
import { ApiError } from '../src/utils/ApiError';

const storage = vi.hoisted(() => ({ uploaded: [] as string[] }));
vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return { ...actual, uploadBufferToS3: vi.fn(async (_b: Buffer, key: string) => (storage.uploaded.push(key), `https://cdn.test/${key}`)) };
});
vi.mock('../src/utils/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/media')>();
  return { ...actual, probeMedia: vi.fn(async () => ({ streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: '9.5', codec_name: 'h264' }], format: {} })) };
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(300, 1)]);
// A real PNG header: 1376×768
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0x05, 0x60, 0, 0, 0x03, 0]), Buffer.alloc(100)]);

const photoHit = { id: 101, tags: 'mountain, lake, sunrise', previewURL: 'https://cdn.pixabay.com/photo/2018/03/03/06/26/girl-3194977_150.jpg', webformatURL: 'https://pixabay.com/get/w.jpg', largeImageURL: 'https://pixabay.com/get/l.jpg', imageWidth: 5472, imageHeight: 3648, user: 'TeeFarm', pageURL: 'https://pixabay.com/photos/101' };
const videoHit = { id: 202, tags: 'city, night', duration: 12, user: 'Someone', pageURL: 'https://pixabay.com/videos/202', videos: { large: { url: 'https://cdn.pixabay.com/v/l.mp4', width: 3840, height: 2160, size: 200_000_000, thumbnail: 'https://cdn.pixabay.com/v/l.jpg' }, medium: { url: 'https://cdn.pixabay.com/v/m.mp4', width: 1920, height: 1080, size: 20_000_000, thumbnail: 'https://cdn.pixabay.com/v/m.jpg' }, tiny: { url: 'https://cdn.pixabay.com/v/t.mp4', width: 640, height: 360, size: 1_000_000, thumbnail: 'https://cdn.pixabay.com/v/t.jpg' } } };

const fetched: string[] = [];
beforeEach(() => {
  (env as any).pixabayApiKey = 'test-key';
  clearStockCache();
  fetched.length = 0;
  storage.uploaded = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string) => {
      const url = String(raw);
      fetched.push(url);
      if (url.startsWith('https://pixabay.com/api/videos/')) return Response.json({ totalHits: 10, hits: [videoHit] });
      if (url.startsWith('https://pixabay.com/api/')) return Response.json({ totalHits: 30, hits: [photoHit] });
      if (url.endsWith('.mp4')) return new Response(new Uint8Array(MP4));
      return new Response(new Uint8Array(JPEG));
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setImageGenerator(null);
});

describe('stock search', () => {
  it('searches photos and videos, and caches', async () => {
    const user = await createUser();
    const photos = await api().get('/api/v1/stock/search?kind=photo&q=mountain lake').set(user.auth);
    expect(photos.status).toBe(200);
    expect(photos.body.items[0]).toMatchObject({ id: '101', kind: 'photo', title: 'mountain, lake, sunrise', width: 1280, height: 853 });
    // Previews come from the CDN (pixabay.com/get links are rate limited)
    expect(photos.body.items[0].preview).toBe('https://cdn.pixabay.com/photo/2018/03/03/06/26/girl-3194977_640.jpg');
    expect(photos.body.next).toBe(2);
    const videos = await api().get('/api/v1/stock/search?kind=video&q=city').set(user.auth);
    // The 4K copy is over the size cap: the 1080p one is used
    expect(videos.body.items[0]).toMatchObject({ id: '202', kind: 'video', width: 1920, height: 1080, duration: 12 });
    expect(videos.body.next).toBe(null);
    await api().get('/api/v1/stock/search?kind=photo&q=mountain lake').set(user.auth);
    expect(fetched.filter((u) => u.startsWith('https://pixabay.com/api/'))).toHaveLength(2);
    expect(fetched.join()).not.toContain(user.user._id);
  });

  it('needs sign-in, a query and a key', async () => {
    expect((await api().get('/api/v1/stock/search?kind=photo&q=x')).status).toBe(401);
    const user = await createUser();
    expect((await api().get('/api/v1/stock/search?kind=photo').set(user.auth)).status).toBe(400);
    (env as any).pixabayApiKey = '';
    expect((await api().get('/api/v1/stock/search?kind=photo&q=x').set(user.auth)).status).toBe(503);
  });
});

describe('stock import', () => {
  it('copies a photo, looked up by id', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/files/import/stock').set(user.auth).send({ kind: 'photo', id: '101' });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'mountain, lake, sunrise.jpg', mimeType: 'image/jpeg', width: 1280, height: 853 });
    expect(fetched).toContain('https://cdn.pixabay.com/photo/2018/03/03/06/26/girl-3194977_1280.jpg');
    expect(fetched).not.toContain('https://pixabay.com/get/l.jpg');
    expect(await File.findById(res.body.file.fileId).lean()).toMatchObject({ source: 'stock', sourceId: 'pixabay:photo:101', status: 'ready' });
  });

  it('copies a video with its poster and probed details', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/files/import/stock').set(user.auth).send({ kind: 'video', id: 202 });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ mimeType: 'video/mp4', width: 1920, height: 1080, duration: 9.5, hasAudio: false });
    expect(res.body.file.thumbnailUrl).toMatch(/thumbnails\/.+\.jpg$/);
    expect(fetched).toContain('https://cdn.pixabay.com/v/m.mp4');
    expect(fetched).not.toContain('https://cdn.pixabay.com/v/l.mp4');
  });

  it('refuses bad ids and files that are not what they claim', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/files/import/stock').set(user.auth).send({ kind: 'photo', id: '../etc' })).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u).includes('/api/') ? Response.json({ hits: [photoHit] }) : new Response('<html>'))));
    expect((await api().post('/api/v1/files/import/stock').set(user.auth).send({ kind: 'photo', id: '101' })).status).toBe(422);
  });

  it('falls back to the next copy when one is rate limited', async () => {
    const user = await createUser();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) => {
        const url = String(raw);
        fetched.push(url);
        if (url.startsWith('https://pixabay.com/api/')) return Response.json({ totalHits: 1, hits: [photoHit] });
        if (url.endsWith('_1280.jpg')) return new Response('slow down', { status: 429 });
        return new Response(new Uint8Array(JPEG));
      })
    );
    const res = await api().post('/api/v1/files/import/stock').set(user.auth).send({ kind: 'photo', id: '101' });
    expect(res.status).toBe(201);
    expect(fetched.filter((u) => !u.includes('/api/'))).toEqual(['https://cdn.pixabay.com/photo/2018/03/03/06/26/girl-3194977_1280.jpg', 'https://pixabay.com/get/l.jpg']);
  });

  it('only fetches Pixabay file links', () => {
    expect(isPixabayFileUrl('https://cdn.pixabay.com/video/a.mp4')).toBe(true);
    expect(isPixabayFileUrl('https://pixabay.com/get/x.jpg')).toBe(true);
    expect(isPixabayFileUrl('http://cdn.pixabay.com/a.mp4')).toBe(false);
    expect(isPixabayFileUrl('https://pixabay.com.evil.com/a.jpg')).toBe(false);
    expect(isPixabayFileUrl('https://169.254.169.254/latest')).toBe(false);
  });
});

describe('image generation', () => {
  it('makes an image, saves it, and counts it', async () => {
    const user = await createUser();
    const asked: string[] = [];
    setImageGenerator(async (prompt, aspect) => (asked.push(`${prompt}|${aspect}`), { bytes: PNG, mimeType: 'image/png' }));
    const res = await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: 'A neon city at night, rain', aspect: '9:16' });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'A neon city at night rain.png', mimeType: 'image/png', width: 1376, height: 768 });
    expect(asked).toEqual(['A neon city at night, rain|9:16']);
    expect(await File.findById(res.body.file.fileId).lean()).toMatchObject({ source: 'ai_image' });
    expect(await Usage.find({ userId: user.user._id, kind: 'aiImages', state: 'settled' }).countDocuments()).toBe(1);
  });

  it('refunds when no image is made, and stops at the plan limit', async () => {
    const user = await createUser();
    setImageGenerator(async () => {
      throw ApiError.withCode(422, 'IMAGE_NOT_MADE', "That image couldn't be made.");
    });
    expect((await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: 'something blocked' })).status).toBe(422);
    expect(await Usage.find({ userId: user.user._id, kind: 'aiImages', state: 'released' }).countDocuments()).toBe(1);

    setImageGenerator(async () => ({ bytes: PNG, mimeType: 'image/png' }));
    for (let i = 0; i < 10; i++) expect((await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: `picture ${i}` })).status).toBe(201);
    const over = await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: 'one more' });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('AI_IMAGES_EXCEEDED');
  });

  it('validates the request', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: 'x' })).status).toBe(400);
    expect((await api().post('/api/v1/ai/image').set(user.auth).send({ prompt: 'a cat', aspect: '2:1' })).status).toBe(400);
  });
});

describe('helpers', () => {
  it('reads file types and image sizes', () => {
    expect(sniffMedia(JPEG)?.type).toBe('image/jpeg');
    expect(sniffMedia(MP4)?.type).toBe('video/mp4');
    expect(sniffMedia(PNG)?.type).toBe('image/png');
    expect(sniffMedia(Buffer.from('<html>'))).toBe(null);
    expect(imageSize(PNG, 'image/png')).toEqual({ width: 1376, height: 768 });
  });
});

describe('assistant tools', () => {
  it('validates add_stock and generate_image', () => {
    expect(checkCalls([{ name: 'add_stock', args: { query: 'city street night', kind: 'video', at: 5, placement: 'fullscreen' } }], {}).problems).toEqual([]);
    expect(checkCalls([{ name: 'generate_image', args: { prompt: 'a neon city', at: 0, placement: 'overlay', position: 'top-right', size: 30, aspect: '1:1' } }], {}).problems).toEqual([]);
    expect(checkCalls([{ name: 'add_stock', args: { query: 'x', kind: 'gif', at: 0, placement: 'fullscreen' } }], {}).problems.length).toBe(1);
    expect(checkCalls([{ name: 'generate_image', args: { prompt: 'a cat', at: 0, placement: 'fullscreen', aspect: '2:1' } }], {}).problems.length).toBe(1);
  });
});
