import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { env } from '../src/config/env';
import { File } from '../src/models/File';
import { User } from '../src/models/User';
import { UsageCounter } from '../src/models/Usage';
import { currentPeriod } from '../src/services/usage.service';
import { clearVoicesCache } from '../src/services/tts/elevenlabs';
import { setTtsProvider, type TtsProvider } from '../src/services/tts';
import { encodeTestWav } from './unit/wavFixture';
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
    getObjectSize: vi.fn(async (key: string) => (storage.uploaded.includes(key) ? 1000 : null)),
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

const sarvam = { calls: [] as any[] };

function fakeFetch(input: string | URL, init: RequestInit = {}) {
  const url = new URL(String(input));
  if (url.hostname === 'api.sarvam.ai') {
    const body = JSON.parse(String(init.body));
    sarvam.calls.push({ ...body, key: (init.headers as any)?.['api-subscription-key'] });
    if (body.text.includes('FAIL')) return Promise.resolve(Response.json({ error: { message: 'bad', code: 'invalid_request_error' } }, { status: 400 }));
    // a second of a 440 Hz tone per request, as base64 WAV
    return Promise.resolve(Response.json({ request_id: 'r1', audios: [encodeTestWav(1, 44100).toString('base64')] }));
  }
  const method = init.method || 'GET';
  eleven.calls.push({ method, path: url.pathname, body: init.body });
  const failStatus = Object.entries(eleven.fail).find(([p]) => url.pathname.startsWith(p))?.[1];
  if (failStatus) {
    return Promise.resolve(new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'nope' } }), { status: failStatus }));
  }
  if (url.pathname === '/v2/voices') return Promise.resolve(Response.json({ voices: STOCK }));
  if (url.pathname === '/v1/shared-voices') {
    return Promise.resolve(Response.json({
      has_more: true,
      voices: [{ voice_id: 'lib1', name: 'Rahul - Hinglish', gender: 'male', accent: 'standard', use_case: 'social_media', preview_url: 'https://p.test/rahul.mp3', language: 'hi' }],
    }));
  }
  if (url.pathname.startsWith('/v1/text-to-speech/')) {
    // "Hi there": H i _ t h e r e, a tenth of a second each
    const characters = [...'Hi there'];
    const alignment = { characters, character_start_times_seconds: characters.map((_, i) => i / 10), character_end_times_seconds: characters.map((_, i) => (i + 1) / 10) };
    return Promise.resolve(Response.json({ audio_base64: Buffer.alloc(64_000, 1).toString('base64'), alignment }));
  }
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
  setTtsProvider(null);
  (env as any).ttsProvider = 'elevenlabs';
  (env as any).elevenLabsApiKey = 'test-key';
  (env as any).sarvamApiKey = 'sarvam-key';
  sarvam.calls = [];
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
    expect(JSON.stringify(res.body)).toMatch(/VOICE_FEATURE_NOT_ENABLED/);
    expect(JSON.stringify(res.body)).toMatch(/The voice list isn't switched on/);
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
    expect(call.path).toBe('/v1/text-to-speech/stockVoice1/with-timestamps');
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

    const stolen = await api().post('/api/v1/voice/speech').set(other.auth).send({ text: 'Hello', voiceId: 'ownersVoice', voiceName: 'Me' });
    expect(stolen.status).toBe(404);
    expect(eleven.calls.some((c) => c.path.startsWith('/v1/text-to-speech/'))).toBe(false);

    // Any voice-library voice is fine
    const library = await api().post('/api/v1/voice/speech').set(other.auth).send({ text: 'Hello', voiceId: 'libraryVoice9', voiceName: 'Rahul / Hinglish' });
    expect(library.status).toBe(201);
    expect(library.body.file.name).toBe('Hello - Rahul Hinglish.mp3');

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

describe('captions for generated speech', () => {
  it("saves the word timings as the file's transcript, so captions are free and instant", async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hi there', voiceId: 'stockVoice1' });
    expect(res.status).toBe(201);
    expect(res.body.transcript.words).toEqual([
      { text: 'Hi', start: 0, end: 0.2, type: 'word' },
      { text: ' ', start: 0.2, end: 0.3, type: 'spacing' },
      { text: 'there', start: 0.3, end: 0.8, type: 'word' },
    ]);
    // Generate Captions on the clip gets it straight away, without transcribing or charging
    const captions = await api().post('/api/v1/transcriptions').set(user.auth).send({ fileId: res.body.file.fileId });
    expect(captions.status).toBe(200);
    expect(captions.body).toMatchObject({ status: 'completed', transcriptionModel: 'elevenlabs-tts' });
    expect(captions.body.words.filter((w: any) => w.type === 'word').map((w: any) => w.text)).toEqual(['Hi', 'there']);
    expect((await UsageCounter.findOne({ userId: user.user._id, kind: 'transcriptionMinutes' }).lean())?.total ?? 0).toBe(0);
  });
});

describe('voice library', () => {
  it('searches ElevenLabs\' library with the filters given', async () => {
    const user = await createUser();
    const res = await api().get('/api/v1/voice/voices/search?text=hinglish&language=hi&gender=male&page=2').set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasMore: true,
      voices: [{ id: 'lib1', name: 'Rahul', gender: 'male', description: 'Hinglish', useCase: 'social media', previewUrl: 'https://p.test/rahul.mp3' }],
    });
    const call = eleven.calls.find((c) => c.path === '/v1/shared-voices')!;
    expect(call).toBeTruthy();
    expect((await api().get('/api/v1/voice/voices').set(user.auth)).body.librarySearch).toBe(true);
  });

  it('a missing key permission says which feature is off', async () => {
    eleven.fail['/v1/text-to-speech/'] = 401;
    const user = await createUser();
    const res = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hi', voiceId: 'stockVoice1' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toMatch(/Text to speech isn't switched on/);
  });
});

describe('favourite voices', () => {
  it('stars and unstars voices (library ones keep their details), per provider', async () => {
    const user = await createUser();
    const star = (voice: Record<string, unknown>) => api().put('/api/v1/voice/favorites').set(user.auth).send({ voice });
    expect((await star({ id: 'stockVoice2', name: 'Adam', gender: 'male' })).status).toBe(200);
    const lib = await star({ id: 'lib1', name: 'Rahul', description: 'Hinglish', previewUrl: 'https://storage.googleapis.com/eleven/rahul.mp3' });
    expect(lib.body.favorites.map((v: any) => v.id)).toEqual(['lib1', 'stockVoice2']);
    // Starring again doesn't duplicate
    expect((await star({ id: 'lib1', name: 'Rahul' })).body.favorites.length).toBe(2);

    const list = await api().get('/api/v1/voice/voices').set(user.auth);
    expect(list.body.favorites[0]).toEqual({ id: 'lib1', name: 'Rahul' });

    // A starred library voice names the file even without voiceName
    const speech = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hello', voiceId: 'lib1' });
    expect(speech.body.file.name).toBe('Hello - Rahul.mp3');

    const removed = await api().delete('/api/v1/voice/favorites/lib1').set(user.auth);
    expect(removed.body.favorites.map((v: any) => v.id)).toEqual(['stockVoice2']);

    // Other providers have their own list
    (env as any).ttsProvider = 'sarvam';
    expect((await api().get('/api/v1/voice/voices').set(user.auth)).body.favorites).toEqual([]);
  });

  it("refuses look-alike preview hosts and other users' own voices", async () => {
    const user = await createUser();
    const evil = await api().put('/api/v1/voice/favorites').set(user.auth).send({ voice: { id: 'x1', name: 'X', previewUrl: 'https://evilgoogleapis.com/a.mp3' } });
    expect(evil.status).toBe(400);
    const owner = await createUser({ role: 'pro' });
    await User.updateOne({ _id: owner.user._id }, { $set: { voiceClone: { voiceId: 'someonesVoice', name: 'Me', createdAt: new Date() } } });
    expect((await api().put('/api/v1/voice/favorites').set(user.auth).send({ voice: { id: 'someonesVoice', name: 'Me' } })).status).toBe(400);
  });
});

describe('voices: the response describes the provider', () => {
  it('ElevenLabs: no language list, its speed range, hosted previews, own voices', async () => {
    const pro = await createUser({ role: 'pro' });
    const res = await api().get('/api/v1/voice/voices').set(pro.auth);
    expect(res.body).toMatchObject({ languages: null, speed: { min: 0.7, max: 1.2 }, previews: 'hosted', ownVoiceSupported: true, ownVoiceAllowed: true });
  });
});

describe('Sarvam (TTS_PROVIDER=sarvam)', () => {
  beforeEach(() => {
    (env as any).ttsProvider = 'sarvam';
  });

  it('lists Indian voices and languages, generated previews, no own voices', async () => {
    const pro = await createUser({ role: 'pro' });
    const res = await api().get('/api/v1/voice/voices').set(pro.auth);
    expect(res.status).toBe(200);
    expect(res.body.voices.length).toBeGreaterThan(30);
    expect(res.body.voices[0]).toMatchObject({ id: 'shubh', name: 'Shubh' });
    expect(res.body.languages.map((l: any) => l.code)).toEqual(expect.arrayContaining(['hi-IN', 'en-IN', 'ta-IN']));
    expect(res.body).toMatchObject({ speed: { min: 0.5, max: 2 }, previews: 'generated', ownVoiceSupported: false, ownVoiceAllowed: false });
    expect(eleven.calls.length).toBe(0);
  });

  it('speaks long scripts in parts and stores one MP3', async () => {
    const user = await createUser({ role: 'pro' });
    const sentence = 'यह एक लंबा वाक्य है जो बार बार दोहराया जाता है। ';
    const text = sentence.repeat(Math.ceil(4900 / sentence.length)).slice(0, 4900);
    const res = await api().post('/api/v1/voice/speech').set(user.auth).send({ text, voiceId: 'priya', language: 'hi-IN', speed: 1.5 });
    expect(res.status).toBe(201);
    expect(sarvam.calls.length).toBe(3);
    for (const call of sarvam.calls) {
      expect(call).toMatchObject({ language_code: 'hi-IN', speaker: 'priya', model: 'bulbul:v3', pace: 1.5, output_audio_codec: 'wav', key: 'sarvam-key' });
      expect(call.text.length).toBeLessThanOrEqual(2400);
    }
    expect(sarvam.calls.map((c) => c.text).join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    expect(res.body.file).toMatchObject({ mimeType: 'audio/mpeg' });
    expect(res.body.file.name).toMatch(/- Priya\.mp3$/);
    expect(storage.uploaded[0]).toMatch(/\.mp3$/);
  });

  it('needs a supported language; refused scripts are a 422 and refunded', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hi', voiceId: 'priya', language: 'fr-FR' })).status).toBe(400);
    expect((await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hi', voiceId: 'nobody', language: 'hi-IN' })).status).toBe(404);
    const refused = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'FAIL this', voiceId: 'priya', language: 'hi-IN' });
    expect(refused.status).toBe(422);
    expect(await ttsUsed(user.user._id)).toBe(0);
    // No language: the first one (English, India)
    const ok = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hello', voiceId: 'priya' });
    expect(ok.status).toBe(201);
    expect(sarvam.calls.at(-1)).toMatchObject({ language_code: 'en-IN' });
  });

  it('makes a preview once per voice and language, then reuses it', async () => {
    const user = await createUser();
    const first = await api().post('/api/v1/voice/preview').set(user.auth).send({ voiceId: 'kabir', language: 'ta-IN' });
    expect(first.status).toBe(200);
    expect(first.body.url).toMatch(/voice-previews\/sarvam\/kabir-ta-IN\.mp3$/);
    expect(sarvam.calls[0].text).toContain('Kabir');
    const again = await api().post('/api/v1/voice/preview').set(user.auth).send({ voiceId: 'kabir', language: 'ta-IN' });
    expect(again.body.url).toBe(first.body.url);
    expect(sarvam.calls.length).toBe(1);
    expect(await ttsUsed(user.user._id)).toBe(0); // previews aren't charged
  });

  it("own voice isn't offered, but one made with ElevenLabs can still be deleted", async () => {
    const pro = await createUser({ role: 'pro' });
    expect((await api().post('/api/v1/voice/own/sample-url').set(pro.auth).send({ mimeType: 'audio/wav', size: 1000 })).status).toBe(400);
    await User.updateOne({ _id: pro.user._id }, { $set: { voiceClone: { voiceId: 'oldClone', name: 'Me', createdAt: new Date() } } });
    expect((await api().get('/api/v1/voice/voices').set(pro.auth)).body.ownVoice).toBeNull();
    expect((await api().delete('/api/v1/voice/own').set(pro.auth)).status).toBe(200);
    expect(eleven.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/voices/oldClone')).toBe(true);
  });
});

describe('a provider can be injected', () => {
  it('uses whatever setTtsProvider gives it', async () => {
    const speak = vi.fn(async () => ({ audio: Buffer.from('ID3fake'), mimeType: 'audio/mpeg' as const, ext: 'mp3' as const }));
    const fake: TtsProvider = { id: 'sarvam', languages: null, speedRange: { min: 1, max: 1 }, listVoices: async () => [{ id: 'v1', name: 'Fake' }], speak };
    setTtsProvider(fake);
    const user = await createUser();
    const res = await api().post('/api/v1/voice/speech').set(user.auth).send({ text: 'Hello', voiceId: 'v1', speed: 2 });
    expect(res.status).toBe(201);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'v1', text: 'Hello', speed: 1 }));
    expect(eleven.calls.length + sarvam.calls.length).toBe(0);
  });
});

describe('speechFileName', () => {
  it('keeps names short and safe', () => {
    expect(speechFileName('Hi', 'Adam')).toBe('Hi - Adam.mp3');
    expect(speechFileName('a/b:c', 'Adam')).toBe('abc - Adam.mp3');
  });
});
