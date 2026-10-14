import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { UsageCounter } from '../src/models/Usage';
import { currentPeriod } from '../src/services/usage.service';
import { setAudioTools, type AudioTools } from '../src/services/audio';
import { runMaintenanceSweep } from '../src/services/maintenance.service';

const storage = vi.hoisted(() => ({ uploaded: [] as string[] }));
vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    uploadBufferToS3: vi.fn(async (_b: Buffer, key: string) => {
      storage.uploaded.push(key);
      return `https://cdn.test/${key}`;
    }),
  };
});
vi.mock('../src/utils/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/media')>();
  return { ...actual, probeMedia: vi.fn(async () => ({ streams: [{ codec_type: 'audio', duration: '12.5' }], format: {} })) };
});
const extract = vi.hoisted(() => ({ fail: null as string | null, urls: [] as string[] }));
vi.mock('../src/utils/audioEncode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/audioEncode')>();
  return {
    ...actual,
    extractAudioMp3: vi.fn(async (url: string) => {
      extract.urls.push(url);
      if (extract.fail) throw new Error(extract.fail);
      return Buffer.from('ID3source');
    }),
  };
});

const dubState = vi.hoisted(() => ({ status: { state: 'dubbing' } as any }));
const tools = {
  isolateVoice: vi.fn(async () => Buffer.alloc(20_000, 2)),
  soundEffect: vi.fn(async () => Buffer.alloc(8_000, 3)),
  music: vi.fn(async () => Buffer.alloc(40_000, 5)),
  startDub: vi.fn(async () => ({ id: 'dub123', expectedSeconds: 40 })),
  dubStatus: vi.fn(async () => dubState.status),
  dubbedAudio: vi.fn(async () => Buffer.alloc(30_000, 4)),
  deleteDub: vi.fn(async () => undefined),
} satisfies AudioTools;

beforeEach(() => {
  storage.uploaded = [];
  extract.fail = null;
  extract.urls = [];
  tools.isolateVoice.mockClear();
  tools.soundEffect.mockClear();
  Object.values(tools).forEach((f) => f.mockClear());
  dubState.status = { state: 'dubbing' };
  setAudioTools(tools);
});
afterEach(() => setAudioTools(null));

const used = async (userId: unknown, kind: string) =>
  (await UsageCounter.findOne({ userId, kind, period: currentPeriod() }).lean())?.total ?? 0;

async function videoFor(userId: unknown, seconds = 30, extra: Record<string, unknown> = {}) {
  return File.create({
    userId, name: 'Interview take 3.mp4', originalName: 'Interview take 3.mp4', mimeType: 'video/mp4', size: 1000,
    storageKey: `users/${userId}/uploads/v-${Math.random().toString(36).slice(2)}.mp4`, cdnUrl: 'https://cdn.test/v.mp4', status: 'ready', source: 'upload',
    metadata: { duration: seconds, hasAudio: true }, ...extra,
  });
}

describe('clean up audio', () => {
  it("makes a clean MP3 of a video's sound and charges its minutes", async () => {
    const user = await createUser();
    const video = await videoFor(user.user._id, 30);
    const res = await api().post('/api/v1/voice/cleanup').set(user.auth).send({ fileId: String(video._id) });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'Interview take 3 (clean).mp3', mimeType: 'audio/mpeg', duration: 12.5 });
    expect(extract.urls).toEqual(['https://cdn.test/v.mp4']);
    expect(tools.isolateVoice).toHaveBeenCalledWith(Buffer.from('ID3source'), 'source.mp3');
    expect(await File.findById(res.body.file.fileId).lean()).toMatchObject({ source: 'audio_cleanup', status: 'ready' });
    expect(await used(user.user._id, 'audioCleanupMinutes')).toBe(30); // seconds
  });

  it('refuses over the monthly minutes, files without sound, and other users\' files', async () => {
    const user = await createUser(); // free: 2 minutes
    const long = await videoFor(user.user._id, 150);
    const over = await api().post('/api/v1/voice/cleanup').set(user.auth).send({ fileId: String(long._id) });
    expect(over.status).toBe(403);
    expect(JSON.stringify(over.body)).toMatch(/AUDIO_CLEANUP_MINUTES_EXCEEDED/);

    const silent = await videoFor(user.user._id, 10, { metadata: { duration: 10, hasAudio: false } });
    expect((await api().post('/api/v1/voice/cleanup').set(user.auth).send({ fileId: String(silent._id) })).status).toBe(400);

    const other = await createUser();
    const theirs = await videoFor(other.user._id, 10);
    expect((await api().post('/api/v1/voice/cleanup').set(user.auth).send({ fileId: String(theirs._id) })).status).toBe(404);
    expect(tools.isolateVoice).not.toHaveBeenCalled();
  });

  it('refunds when the clean-up fails', async () => {
    const user = await createUser();
    const video = await videoFor(user.user._id, 20);
    tools.isolateVoice.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    const res = await api().post('/api/v1/voice/cleanup').set(user.auth).send({ fileId: String(video._id) });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await used(user.user._id, 'audioCleanupMinutes')).toBe(0);
    expect(storage.uploaded).toEqual([]);
  });
});

describe('sound effects', () => {
  it('makes an effect from a description and counts it', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/voice/sound-effect').set(user.auth).send({ prompt: 'Whoosh / swish transition', duration: 1.5 });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'SFX - Whoosh swish transition.mp3', mimeType: 'audio/mpeg' });
    expect(tools.soundEffect).toHaveBeenCalledWith('Whoosh / swish transition', 1.5);
    expect(await used(user.user._id, 'soundEffects')).toBe(1);
  });

  it('stops at the monthly limit and validates the request', async () => {
    const user = await createUser(); // free: 5
    for (let i = 0; i < 5; i++) expect((await api().post('/api/v1/voice/sound-effect').set(user.auth).send({ prompt: 'pop' })).status).toBe(201);
    const sixth = await api().post('/api/v1/voice/sound-effect').set(user.auth).send({ prompt: 'pop' });
    expect(sixth.status).toBe(403);
    expect(JSON.stringify(sixth.body)).toMatch(/SOUND_EFFECTS_EXCEEDED/);
    expect((await api().post('/api/v1/voice/sound-effect').set(user.auth).send({ prompt: 'x' })).status).toBe(400);
    expect((await api().post('/api/v1/voice/sound-effect').set(user.auth).send({ prompt: 'boom', duration: 60 })).status).toBe(400);
  });
});

describe('background music', () => {
  it('makes instrumental music to a length, counted like a sound effect', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/voice/music').set(user.auth).send({ prompt: 'polished corporate ambient, soft piano', duration: 30 });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'Music - polished corporate ambient, soft piano.mp3', mimeType: 'audio/mpeg' });
    expect(tools.music).toHaveBeenCalledWith('polished corporate ambient, soft piano', 30);
    expect(await used(user.user._id, 'soundEffects')).toBe(1);
    expect((await api().post('/api/v1/voice/music').set(user.auth).send({ prompt: 'calm', duration: 600 })).status).toBe(400);
  });
});

describe('dubbing', () => {
  it('starts a dub of the sound, then finishes it when the provider is done', async () => {
    const user = await createUser({ role: 'pro' });
    const video = await videoFor(user.user._id, 30);
    const start = await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(video._id), language: 'hi' });
    expect(start.status).toBe(202);
    expect(start.body.dub).toMatchObject({ status: 'processing', language: 'hi', expectedSeconds: 40 });
    expect(tools.startDub).toHaveBeenCalledWith(Buffer.from('ID3source'), 'Interview take 3.mp3', 'hi');
    expect(await used(user.user._id, 'dubbingMinutes')).toBe(30); // reserved
    // Not in Media while it works
    expect((await api().get('/api/v1/files?type=audio').set(user.auth)).body.data.length).toBe(0);

    const id = start.body.dub.fileId;
    expect((await api().get(`/api/v1/voice/dub/${id}`).set(user.auth)).body.dub.status).toBe('processing');
    dubState.status = { state: 'dubbed' };
    const done = await api().get(`/api/v1/voice/dub/${id}`).set(user.auth);
    expect(done.body.dub).toMatchObject({ status: 'ready', file: { name: 'Interview take 3 (Hindi).mp3', mimeType: 'audio/mpeg', duration: 12.5 } });
    expect(tools.dubbedAudio).toHaveBeenCalledWith('dub123', 'hi');
    expect(tools.deleteDub).toHaveBeenCalledWith('dub123');
    expect(await used(user.user._id, 'dubbingMinutes')).toBe(30);
    expect((await api().get('/api/v1/files?type=audio').set(user.auth)).body.data.length).toBe(1);
  });

  it('refunds a failed dub, and the sweep finishes dubs nobody is watching', async () => {
    const user = await createUser({ role: 'pro' });
    const a = await videoFor(user.user._id, 20);
    const failing = (await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(a._id), language: 'es' })).body.dub.fileId;
    dubState.status = { state: 'failed', error: 'no speech' };
    const failed = await api().get(`/api/v1/voice/dub/${failing}`).set(user.auth);
    expect(failed.body.dub).toMatchObject({ status: 'failed' });
    expect(await used(user.user._id, 'dubbingMinutes')).toBe(0);

    dubState.status = { state: 'dubbing' };
    const b = await videoFor(user.user._id, 10);
    const pending = (await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(b._id), language: 'fr' })).body.dub.fileId;
    await File.updateOne({ _id: pending }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }, { timestamps: false });
    dubState.status = { state: 'dubbed' };
    const counts = await runMaintenanceSweep();
    expect(counts.dubsFinished).toBe(1);
    expect((await File.findById(pending).lean())?.status).toBe('ready');
  });

  it('checks the language, length, plan and owner', async () => {
    const user = await createUser(); // free: 1 minute
    const short = await videoFor(user.user._id, 30);
    expect((await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(short._id), language: 'xx' })).status).toBe(400);
    const long = await videoFor(user.user._id, 6 * 60);
    expect((await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(long._id), language: 'hi' })).status).toBe(400);
    const tooMuch = await videoFor(user.user._id, 90);
    const over = await api().post('/api/v1/voice/dub').set(user.auth).send({ fileId: String(tooMuch._id), language: 'hi' });
    expect(over.status).toBe(403);
    expect(JSON.stringify(over.body)).toMatch(/DUBBING_MINUTES_EXCEEDED/);
    const other = await createUser();
    expect((await api().get(`/api/v1/voice/dub/${String(short._id)}`).set(other.auth)).status).toBe(404);
    expect(tools.startDub).not.toHaveBeenCalled();
    expect(await File.countDocuments({ source: 'dubbing' })).toBe(0);
  });
});
