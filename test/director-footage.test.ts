import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'fs/promises';
import { createUser } from './helpers';
import { File } from '../src/models/File';
import { Transcription } from '../src/models/Transcription';
import { MediaAnalysis } from '../src/models/MediaAnalysis';
import { setGeminiClient, type GeminiRequest, type GeminiResult } from '../src/services/ai/gemini';
import { footageAnalysis, timeOf, transcriptLines } from '../src/services/director/footage';

// ffmpeg is replaced: the "small copy" is a few bytes written where asked
const ffmpegCalls: string[][] = [];
vi.mock('../src/utils/media', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/media')>();
  return {
    ...real,
    runFfmpegOnUrl: vi.fn(async (_url: string, before: string[], after: string[]) => {
      ffmpegCalls.push([...before, ...after]);
      await writeFile(after[after.length - 1], Buffer.from('small copy'));
      return '';
    }),
  };
});

const requests: GeminiRequest[] = [];
let answer: (req: GeminiRequest) => unknown = () => ({});
const fake = {
  generate: vi.fn(async (req: GeminiRequest): Promise<GeminiResult> => {
    requests.push(req);
    const json = answer(req);
    return { text: JSON.stringify(json), json, calls: [], usage: { input: 1, output: 1 }, model: req.model };
  }),
};

const piece = (extra: Record<string, unknown> = {}) => ({
  summary: 'A host walks through Lisbon.',
  kind: 'vlog',
  language: 'en',
  hasSpeech: true,
  hasMusic: true,
  shots: [{ start: '0:00', end: '0:12.5', description: 'Aerial of the city', framing: 'aerial' }],
  speech: [{ start: '0:03', end: '0:05', speaker: 'host', text: 'Good morning from Lisbon.' }],
  moments: [
    { start: '0:02', end: '0:06', title: 'Opening line', why: 'Sets up the trip', kind: 'hook', score: 8 },
    { start: '4:50', end: '9:00', title: 'Runs past the end', why: 'clamped', kind: 'visual', score: 15 },
  ],
  ...extra,
});

async function video(userId: unknown, duration: number, mimeType = 'video/mp4') {
  return File.create({
    userId, name: 'lisbon.mp4', originalName: 'lisbon.mp4', mimeType, size: 10,
    storageKey: `users/${userId}/uploads/${Math.random().toString(36).slice(2)}.mp4`,
    cdnUrl: 'https://cdn.test/v.mp4', status: 'ready', source: 'upload', metadata: { duration },
  });
}

beforeEach(() => {
  requests.length = 0;
  ffmpegCalls.length = 0;
  answer = () => piece();
  setGeminiClient(fake);
});
afterEach(() => setGeminiClient(null));

describe('times', () => {
  it('reads MM:SS, MM:SS.s, H:MM:SS and plain seconds', () => {
    expect(timeOf('0:40')).toBe(40);
    expect(timeOf('1:05.5')).toBe(65.5);
    expect(timeOf('1:00:02')).toBe(3602);
    expect(timeOf(12.25)).toBe(12.25);
    expect(timeOf('soon')).toBeNaN();
  });

  it('groups transcript words into sentences, breaking on pauses and speakers', () => {
    const lines = transcriptLines([
      { text: 'Good', start: 0, end: 0.3, type: 'word', speaker_id: 'a' },
      { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
      { text: 'morning.', start: 0.35, end: 0.8, type: 'word', speaker_id: 'a' },
      { text: 'Hi', start: 0.9, end: 1.1, type: 'word', speaker_id: 'b' },
      { text: 'there', start: 2.5, end: 2.9, type: 'word', speaker_id: 'b' },
    ]);
    expect(lines).toEqual([
      { start: 0, end: 0.8, speaker: 'a', text: 'Good morning.' },
      { start: 0.9, end: 1.1, speaker: 'b', text: 'Hi' },
      { start: 2.5, end: 2.9, speaker: 'b', text: 'there' },
    ]);
  });
});

describe('footage analysis', () => {
  it('watches a short video once, in file seconds, and keeps it', async () => {
    const { user } = await createUser();
    const file = await video(user._id, 30);
    const first = await footageAnalysis(file._id, user._id);
    expect(first?.status).toBe('ready');
    expect(first?.speechSource).toBe('model');
    expect(first?.result?.shots[0]).toMatchObject({ start: 0, end: 12.5 });
    // Spans past the end of the file are dropped (here: one starting at 4:50 of a 30 s file)
    expect(first?.result?.moments.map((m) => [m.title, m.start, m.end, m.score])).toEqual([['Opening line', 2, 6, 8]]);
    // Sent as a small inline video, JSON answer, fast model
    expect(requests[0].messages[0].media?.[0]).toMatchObject({ mimeType: 'video/mp4' });
    expect(requests[0].jsonSchema).toBeTruthy();
    expect(ffmpegCalls[0]).toEqual(expect.arrayContaining(['-ss', '0', '-t', '30', 'scale=-2:360,fps=2']));

    const again = await footageAnalysis(file._id, user._id);
    expect(String(again?._id)).toBe(String(first?._id));
    expect(requests).toHaveLength(1);
  });

  it('long files are watched in 5-minute pieces whose times are moved into place', async () => {
    const { user } = await createUser();
    const file = await video(user._id, 610);
    const done = await footageAnalysis(file._id, user._id);
    // 0–300, 300–610 (the 10 s sliver joins the last piece)
    expect(ffmpegCalls.map((c) => [c[c.indexOf('-ss') + 1], c[c.indexOf('-t') + 1]])).toEqual([['0', '300'], ['300', '310']]);
    expect(done?.result?.shots.map((s) => s.start)).toEqual([0, 300]);
    expect(done?.result?.speech.map((l) => l.start)).toEqual([3, 303]);
    expect(done?.analysedSeconds).toBe(610);
  });

  it('uses the transcript the file already has instead of listening', async () => {
    const { user } = await createUser();
    const file = await video(user._id, 20);
    await Transcription.create({
      userId: user._id, fileId: file._id, status: 'completed', language: 'pt', text: 'Bom dia.',
      words: [{ text: 'Bom', start: 1, end: 1.4, type: 'word' }, { text: 'dia.', start: 1.4, end: 1.9, type: 'word' }],
    } as any);
    const done = await footageAnalysis(file._id, user._id);
    expect(done?.speechSource).toBe('transcript');
    expect(done?.result?.speech).toHaveLength(1);
    expect(done?.result?.speech[0]).toMatchObject({ start: 1, end: 1.9, text: 'Bom dia.' });
    expect(done?.result?.language).toBe('pt');
    expect(requests[0].messages[0].text).toContain('leave "speech" empty');
    expect(requests[0].messages[0].text).toContain('Bom dia.');
  });

  it("only the owner's video or audio files; failures are recorded, not retried at once", async () => {
    const { user } = await createUser();
    const { user: other } = await createUser();
    const file = await video(user._id, 20);
    expect(await footageAnalysis(file._id, other._id)).toBeNull();
    const picture = await video(user._id, 0, 'image/png');
    expect(await footageAnalysis(picture._id, user._id)).toBeNull();

    answer = () => {
      throw new Error('Vertex down');
    };
    const failed = await footageAnalysis(file._id, user._id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Vertex down');
    answer = () => piece();
    expect((await footageAnalysis(file._id, user._id))?.status).toBe('failed');
    expect(await MediaAnalysis.countDocuments({ fileId: file._id })).toBe(1);
  });
});
