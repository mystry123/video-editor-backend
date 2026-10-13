import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { isGiphyMediaUrl } from '../src/controllers/giphy.controller';
import { checkCalls } from '../src/services/ai/editorTools';

const storage = vi.hoisted(() => ({ uploaded: [] as string[] }));
vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return { ...actual, uploadBufferToS3: vi.fn(async (_b: Buffer, key: string) => (storage.uploaded.push(key), `https://cdn.test/${key}`)) };
});

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)]);
let body: Buffer = GIF;
const fetched: string[] = [];
beforeEach(() => {
  body = GIF;
  fetched.length = 0;
  storage.uploaded = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (fetched.push(String(url)), new Response(new Uint8Array(body), { status: 200 }))));
});
afterEach(() => vi.unstubAllGlobals());

describe('GIPHY import', () => {
  it('only accepts GIPHY media links', () => {
    expect(isGiphyMediaUrl('https://media2.giphy.com/media/abc/giphy.gif')).toBe(true);
    expect(isGiphyMediaUrl('https://i.giphy.com/abc.webp')).toBe(true);
    expect(isGiphyMediaUrl('http://media.giphy.com/media/abc/giphy.gif')).toBe(false);
    expect(isGiphyMediaUrl('https://media.giphy.com.evil.com/a.gif')).toBe(false);
    expect(isGiphyMediaUrl('https://media.giphy.com/media/abc/giphy.mp4')).toBe(false);
    expect(isGiphyMediaUrl('https://169.254.169.254/latest/meta-data.gif')).toBe(false);
  });

  it('copies the GIF into the user\'s media', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/files/import/giphy').set(user.auth).send({ url: 'https://media1.giphy.com/media/xyz/giphy.gif', title: 'Mind Blown GIF', width: 480, height: 270 });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'Mind Blown GIF.gif', mimeType: 'image/gif', width: 480, height: 270 });
    expect(storage.uploaded[0]).toMatch(new RegExp(`^users/${user.user._id}/uploads/.+\\.gif$`));
    expect(await File.findById(res.body.file.fileId).lean()).toMatchObject({ source: 'giphy', status: 'ready' });
  });

  it('refuses other hosts and files that aren\'t GIFs', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/files/import/giphy').set(user.auth).send({ url: 'https://example.com/a.gif' })).status).toBe(400);
    expect(fetched).toEqual([]);
    body = Buffer.from('<html>not a gif</html>');
    expect((await api().post('/api/v1/files/import/giphy').set(user.auth).send({ url: 'https://media.giphy.com/media/a/giphy.gif' })).status).toBe(422);
  });
});

describe('assistant add_gif tool', () => {
  it('validates the call', () => {
    expect(checkCalls([{ name: 'add_gif', args: { query: 'fire emoji', kind: 'sticker', at: 2, position: 'top-right', size: 25 } }], {}).problems).toEqual([]);
    expect(checkCalls([{ name: 'add_gif', args: { query: 'x', kind: 'video', at: 2 } }], {}).problems.length).toBe(1);
  });
});
