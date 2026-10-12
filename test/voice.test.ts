import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { env } from '../src/config/env';
import { File } from '../src/models/File';
import { User } from '../src/models/User';
import { UsageCounter } from '../src/models/Usage';
import { currentPeriod } from '../src/services/usage.service';
import { clearVoicesCache } from '../src/services/voice.service';
import { speechFileName } from '../src/controllers/voice.controller';

const storage = vi.hoisted(() => ({
  uploaded: [] as string[],
  deleted: [] as string[],
  sample: Buffer.from('RIFF....WAVEfmt sample'),
}));

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    createPresignedUpload: vi.fn(async ({ key }: { key: string }) => ({ url: 'https://s3.test/', fields: { key } })),
    uploadBufferToS3: vi.fn(async (_buffer: Buffer, key: string) => {
      storage.uploaded.push(key);
      return `https://cdn.test/${key}`;
    }),
    readObjectStart: vi.fn(async () => storage.sample),
    deleteFromS3: vi.fn(async (key: string) => {
      storage.deleted.push(key);
    }),
  };
});

const probe = vi.hoisted(() => ({ seconds: 4 }));
vi.mock('../src/utils/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/media')>();
  return {
    ...actual,
    probeMedia: vi.fn(async () => ({ streams: [{ codec_type: 'audio', duration: String(probe.seconds) }], format: {} })),
  };
});

const STOCK = [
  { voice_id: 'stockVoice1', name: 'Rachel - Calm narrator', labels: { gender: 'female', accent: 'american' }, preview_url: 'https://p.test/r.mp3' },
  { voice_id: 'stockVoice2', name: 'Adam', labels: { gender: 'male' } },
];

/** Fake ElevenLabs: records calls; `fail` makes a path return that status. */
const eleven = { calls: [] as Array<{ method: string; path: string; body?: any }>, fail: {} as Record<string, number> };

function fakeFetch(input: string | URL, init: RequestInit = {}) {
  const url = new URL(String(input));
  const method = init.method || 'GET';
  eleven.calls.push({ method, path: url.pathname, body: init.body });
  const failStatus = Object.entries(eleven.fail).find(([p]) => url.pathname.startsWith(p))?.[1];
  if (failStatus) {
    return Promise.resolve(new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'nope' } }), { status: failStatus }));
  }
  if (url.pathname === '/v2/voices') return Promise.resolve(Response.json({ voices: STOCK }));
  if (url.pathname.startsWith('/v1/text-to-speech/')) return Promise.resolve(new Response(Buffer.alloc(64_000, 1), { status: 200 }));
  if (url.pathname === '/v1/voices/add') return Promise.resolve(Response.json({ voice_id: `cloned${eleven.calls.length}` }));
  if (url.pathname.startsWith('/v1/voices/') && method === 'DELETE') return Promise.resolve(Response.json({ status: 'ok' }));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

beforeEach(() => {
  eleven.calls = [];
  eleven.fail = {};
  storage.uploaded = [];
  storage.deleted = [];
  probe.seconds = 4;
  clearVoicesCache();
  (env as any).elevenLabsApiKey = 'test-key';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ttsUsed = async (userId: unknown) =>
  (await UsageCounter.findOne({ userId, kind: 'ttsCharacters', period: currentPeriod() }).lean())?.total ?? 0;

async function sampleFor(auth: Record<string, string>) {
  const res = await api().post('/api/v1/voice/own/sample-url').set(auth).send({ mimeType: 'audio/wav', size: 2_000_000 });
  expect(res.status).toBe(200);
  return res.body.sampleId as string;
}

describe('voices', () => {
  it('lists stock voices and whether the plan allows an own voice', async () => {
    const free = await createUser();
    const res = await api().get('/api/v1/voice/voices').set(free.auth);
    expect(res.status).toBe(200);
    expect(res.body.voices.map((v: any) => v.name)).toEqual(['Rachel', 'Adam']);
    expect(res.body.voices[0]).toMatchObject({ id: 'stockVoice1', gender: 'female', previewUrl: 'https://p.test/r.mp3' });
    expect(res.body.ownVoice).toBeNull();
    expect(res.body.ownVoiceAllowed).toBe(false);
  });

  it('a key without permissions is a clear 503, not an ElevenLabs error', async () => {
    eleven.fail['/v2/voices'] = 401;
    const user = await createUser();
    const res = await api().get('/api/v1/voice/voices').set(user.auth);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toMatch(/VOICE_UNAVAILABLE/);
    expect(JSON.stringify(res.body)).not.toMatch(/missing_permissions/);
  });
});

describe('text to speech', () => {
  it('makes an MP3 in their media and charges characters', async () => {
    const user = await createUser();
    const text = 'Hey everyone, welcome back to the channel. Today we look at three editing tricks.';
    const res = await api().post('/api/v1/voice/speech').set(user.auth).send({ text, voiceId: 'stockVoice1', speed: 1.1 });
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ mimeType: 'audio/mpeg', duration: 4 });
    expect(res.body.file.name).toBe('Hey everyone, welcome back to the… - Rachel.mp3');

    const file = await File.findById(res.body.file.fileId).lean();
    expect(file).toMatchObject({ source: 'tts', status: 'ready', mimeType: 'audio/mpeg' });
    expect(storage.uploaded[0]).toMatch(new RegExp(`^users/${user.user._id}/uploads/.+\\.mp3$`));
    expect(await ttsUsed(user.user._id)).toBe(text.length);

    const call = eleven.calls.find((c) => c.path.startsWith('/v1/text-to-speech/'))!;
    expect(call.path).toBe('/v1/text-to-speech/stockVoice1');
    expect(JSON.parse(call.body)).toMatchObject({ text, model_id: 'eleven_multilingual_v2', voice_settings: { speed: 1.1 } });
  });

  it('refuses over the monthly character limit, and refunds a failed request', async () => {
    const user = await createUser(); // free: 1,000 characters
    const tooMuch = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'a'.repeat(1001), voiceId: 'stockVoice1' });
    expect(tooMuch.status).toBe(403);
    expect(JSON.stringify(tooMuch.body)).toMatch(/TTS_CHARACTERS_EXCEEDED/);

    eleven.fail['/v1/text-to-speech/'] = 500;
    const failed = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hello there', voiceId: 'stockVoice1' });
    expect(failed.status).toBe(503);
    expect(await ttsUsed(user.user._id)).toBe(0);
    expect(await File.countDocuments({ userId: user.user._id })).toBe(0);
  });

  it("can't use an unknown voice or another user's own voice", async () => {
    const owner = await createUser({ role: 'pro' });
    await User.updateOne({ _id: owner.user._id }, { $set: { voiceClone: { voiceId: 'ownersVoice', name: 'Me', createdAt: new Date() } } });
    const other = await createUser({ role: 'pro' });

    for (const voiceId of ['ownersVoice', 'madeUpVoice']) {
      const res = await api().post('/api/v1/voice/speech').set(other.auth).send({ text: 'Hello', voiceId });
      expect(res.status).toBe(404);
    }
    expect(eleven.calls.some((c) => c.path.startsWith('/v1/text-to-speech/'))).toBe(false);

    const mine = await api().post('/api/v1/voice/speech').set(owner.auth).send({ text: 'Hello', voiceId: 'ownersVoice' });
    expect(mine.status).toBe(201);
    expect(mine.body.file.name).toBe('Hello - Me.mp3');
  });

  it('validates the script', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/voice/speech').set(user.auth).send({ text: '   ', voiceId: 'stockVoice1' })).status).toBe(400);
    expect((await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'x'.repeat(5001), voiceId: 'stockVoice1' })).status).toBe(400);
    expect((await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'hi', voiceId: '../../v1/voices' })).status).toBe(400);
  });
});

describe('own voice', () => {
  it('is for paid plans only', async () => {
    const free = await createUser();
    const res = await api().post('/api/v1/voice/own/sample-url').set(free.auth).send({ mimeType: 'audio/wav', size: 1000 });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/VOICE_CLONE_NOT_ALLOWED/);
  });

  it('is made from a recorded sample, which is then deleted; one per user', async () => {
    const pro = await createUser({ role: 'pro' });
    probe.seconds = 45;
    const sampleId = await sampleFor(pro.auth);
    const sample = await File.findById(sampleId).lean();
    expect(sample?.storageKey).toMatch(new RegExp(`^users/${pro.user._id}/voice-samples/`));

    const noConsent = await api().post('/api/v1/voice/own').set(pro.auth).send({ sampleId, name: 'My voice' });
    expect(noConsent.status).toBe(400);

    const res = await api().post('/api/v1/voice/own').set(pro.auth).send({ sampleId, name: 'My voice', consent: true });
    expect(res.status).toBe(201);
    expect(res.body.ownVoice).toMatchObject({ name: 'My voice' });
    expect((await User.findById(pro.user._id).lean())?.voiceClone).toMatchObject({ voiceId: res.body.ownVoice.id, name: 'My voice' });
    expect(eleven.calls.some((c) => c.path === '/v1/voices/add')).toBe(true);
    // The recording is gone
    expect(storage.deleted).toContain(sample!.storageKey);
    expect(await File.exists({ _id: sampleId })).toBeNull();

    const list = await api().get('/api/v1/voice/voices').set(pro.auth);
    expect(list.body.ownVoice).toMatchObject({ id: res.body.ownVoice.id, name: 'My voice' });

    // A second one needs the first deleted
    expect((await api().post('/api/v1/voice/own/sample-url').set(pro.auth).send({ mimeType: 'audio/wav', size: 1000 })).status).toBe(409);
    const del = await api().delete('/api/v1/voice/own').set(pro.auth);
    expect(del.status).toBe(200);
    expect(eleven.calls.some((c) => c.method === 'DELETE' && c.path === `/v1/voices/${res.body.ownVoice.id}`)).toBe(true);
    expect((await User.findById(pro.user._id).lean())?.voiceClone).toBeUndefined();
  });

  it('needs at least 20 seconds, and only their own recent sample', async () => {
    const pro = await createUser({ role: 'pro' });
    probe.seconds = 8;
    const short = await api().post('/api/v1/voice/own').set(pro.auth).send({ sampleId: await sampleFor(pro.auth), name: 'Me', consent: true });
    expect(short.status).toBe(422);
    expect(JSON.stringify(short.body)).toMatch(/VOICE_SAMPLE_TOO_SHORT/);
    expect(storage.deleted.length).toBe(1); // the sample is deleted either way

    // A regular upload can't be used as a sample
    const upload = await File.create({ userId: pro.user._id, name: 'clip.mp3', originalName: 'clip.mp3', mimeType: 'audio/mpeg', size: 1, storageKey: `users/${pro.user._id}/uploads/x.mp3`, cdnUrl: 'https://cdn.test/x.mp3', status: 'ready', source: 'upload' });
    const notSample = await api().post('/api/v1/voice/own').set(pro.auth).send({ sampleId: String(upload._id), name: 'Me', consent: true });
    expect(notSample.status).toBe(400);
    expect(await File.exists({ _id: upload._id })).not.toBeNull();

    // Nor someone else's
    const other = await createUser({ role: 'pro' });
    probe.seconds = 60;
    const theirs = await sampleFor(other.auth);
    expect((await api().post('/api/v1/voice/own').set(pro.auth).send({ sampleId: theirs, name: 'Me', consent: true })).status).toBe(400);
    expect(eleven.calls.some((c) => c.path === '/v1/voices/add')).toBe(false);
  });
});

describe('speechFileName', () => {
  it('keeps names short and safe', () => {
    expect(speechFileName('Hi', 'Adam')).toBe('Hi - Adam.mp3');
    expect(speechFileName('a/b:c', 'Adam')).toBe('abc - Adam.mp3');
  });
});
