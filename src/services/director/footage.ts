// services/director/footage.ts
//
// Footage understanding for Cue's Director: Gemini watches (or listens to) a
// file and says what is in it: shots, what is said and when, and the moments
// worth using (hooks, highlights, quotes). Kept per file (MediaAnalysis), so
// each file is watched once.
//
// Gemini can't fetch large files from a URL, so it is sent a small copy made
// with ffmpeg: 360p at 2 frames a second (it samples about one a second
// anyway) with mono speech-quality sound, in 5-minute pieces watched in
// parallel. A transcript the file already has is used for the speech (exact
// words and times); otherwise Gemini writes down what is said.

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { probeMedia, runFfmpegOnUrl } from '../../utils/media';
import { File, type IFile } from '../../models/File';
import { Transcription } from '../../models/Transcription';
import {
  MediaAnalysis,
  MEDIA_ANALYSIS_VERSION,
  type AnalysisLine,
  type AnalysisMoment,
  type AnalysisShot,
  type IMediaAnalysis,
  type MediaAnalysisResult,
} from '../../models/MediaAnalysis';
import { getGeminiClient } from '../ai/gemini';

/** Seconds per piece Gemini watches (keeps each request well under its size limit) */
export const PIECE_SECONDS = 300;
/** Longer files: only the first hour is watched */
export const MAX_ANALYSED_SECONDS = 3600;
const PARALLEL_PIECES = 3;
/** A failed analysis isn't tried again sooner than this */
const RETRY_FAILED_AFTER_MS = 10 * 60 * 1000;

/** Times as MM:SS.s, the way Gemini reads video timestamps (bare numbers read as minutes.seconds by some models) */
const num = { type: 'STRING', description: 'MM:SS or MM:SS.s from the start of this clip' } as const;
const str = { type: 'STRING' } as const;

const PIECE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { ...str, description: 'Two or three sentences: what this footage is and how it feels' },
    kind: { ...str, enum: ['talking-head', 'podcast', 'interview', 'vlog', 'tutorial', 'screen-recording', 'b-roll', 'event', 'music', 'gaming', 'product', 'other'] },
    language: { ...str, description: 'Spoken language code (en, hi, …) or empty when nothing is said' },
    hasSpeech: { type: 'BOOLEAN' },
    hasMusic: { type: 'BOOLEAN' },
    hasBurnedCaptions: { type: 'BOOLEAN', description: 'True if subtitles/captions of what is said are already burned into the picture (words appearing as people talk)' },
    shots: {
      type: 'ARRAY',
      description: 'Every shot or scene in order, covering the whole clip',
      items: {
        type: 'OBJECT',
        properties: {
          start: num,
          end: num,
          description: { ...str, description: 'What is seen, concretely (who, what, where)' },
          framing: { ...str, enum: ['wide', 'medium', 'close-up', 'extreme-close-up', 'aerial', 'screen', 'graphic', 'other'] },
          people: { type: 'INTEGER' },
          onScreenText: { ...str, description: 'Text visible in the picture, if any' },
          motion: { ...str, enum: ['static', 'some', 'high'] },
          enters: { ...str, enum: ['cut', 'dissolve', 'fade-in', 'wipe', 'start'], description: 'How this shot begins in the footage: a hard cut, or a dissolve/fade/wipe already edited into it (the overlap is part of this shot)' },
        },
        required: ['start', 'end', 'description'],
      },
    },
    speech: {
      type: 'ARRAY',
      description: 'What is said, sentence by sentence, with who says it. Empty when told the transcript is known.',
      items: { type: 'OBJECT', properties: { start: num, end: num, speaker: str, text: str }, required: ['start', 'end', 'text'] },
    },
    moments: {
      type: 'ARRAY',
      description: 'The best moments to use in a short edit, best first',
      items: {
        type: 'OBJECT',
        properties: {
          start: num,
          end: num,
          title: { ...str, description: 'A few words naming it' },
          why: { ...str, description: 'Why it works (emotion, surprise, payoff, beauty, a strong line…)' },
          kind: { ...str, enum: ['hook', 'highlight', 'quote', 'funny', 'emotional', 'visual', 'payoff', 'call-to-action', 'b-roll'] },
          score: { type: 'INTEGER', description: '1–10: how strong for a short social edit' },
        },
        required: ['start', 'end', 'title', 'why', 'kind', 'score'],
      },
    },
  },
  required: ['summary', 'kind', 'hasSpeech', 'hasMusic', 'shots', 'speech', 'moments'],
};

const SYSTEM = `You are a senior video editor logging footage before an edit. Watch and listen to the whole clip.
Be concrete and accurate: name what is actually seen and heard, never invent. Times are MM:SS (or MM:SS.s) from the start of THIS clip, and must lie within it.
Shots: split at every cut or clear scene change; cover the clip end to end. When the footage itself dissolves, fades or wipes from one shot to the next, mark the new shot's "enters" and make that shot start where the blend starts: editors must know where two pictures are mixed.
Moments: the strongest 3–12 spans (1–20 s each) an editor would pull for a short, punchy social edit: a great opening line or visual hook, a payoff, a quotable line, a striking image, a laugh. Score honestly; most moments are 4–7.`;

/** Words grouped into sentence-sized lines (a pause, sentence end or ~14 words ends one) */
export function transcriptLines(words: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string }>): AnalysisLine[] {
  const lines: AnalysisLine[] = [];
  let current: { start: number; end: number; speaker?: string; words: string[] } | null = null;
  for (const w of words) {
    if (w.type && w.type !== 'word') continue;
    const text = String(w.text || '').trim();
    if (!text) continue;
    const breakHere = current && (w.start - current.end > 0.7 || current.words.length >= 14 || (w.speaker_id && w.speaker_id !== current.speaker));
    if (!current || breakHere) {
      if (current) lines.push({ start: current.start, end: current.end, speaker: current.speaker, text: current.words.join(' ') });
      current = { start: w.start, end: w.end, speaker: w.speaker_id, words: [] };
    }
    current.words.push(text);
    current.end = w.end;
    if (/[.!?]$/.test(text)) {
      lines.push({ start: current.start, end: current.end, speaker: current.speaker, text: current.words.join(' ') });
      current = null;
    }
  }
  if (current) lines.push({ start: current.start, end: current.end, speaker: current.speaker, text: current.words.join(' ') });
  return lines;
}

/** "1:05.5", "01:05", "0:00:12", 65.5 → seconds */
export function timeOf(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(text)) return NaN;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const clampSpan = <T extends { start: unknown; end: unknown }>(x: T, offset: number, from: number, to: number): (Omit<T, 'start' | 'end'> & { start: number; end: number }) | null => {
  const start = Math.max(from, Math.min(to, timeOf(x.start) + offset));
  const end = Math.max(from, Math.min(to, timeOf(x.end) + offset));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) return null;
  return { ...x, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
};

/** A small copy of [start, start + seconds) for Gemini: 360p, 2 fps, mono speech-quality sound */
async function smallCopy(url: string, isVideo: boolean, start: number, seconds: number, dir: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const out = path.join(dir, `piece-${start}.${isVideo ? 'mp4' : 'm4a'}`);
  const encode = isVideo
    ? ['-vf', 'scale=-2:360,fps=2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-ac', '1', '-b:a', '32k', '-movflags', '+faststart']
    : ['-vn', '-c:a', 'aac', '-ac', '1', '-b:a', '48k'];
  await runFfmpegOnUrl(url, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start)], ['-t', String(seconds), ...encode, out], { timeoutMs: 6 * 60_000 });
  return { bytes: await readFile(out), mimeType: isVideo ? 'video/mp4' : 'audio/mp4' };
}

interface PieceResult {
  model: string;
  result: MediaAnalysisResult;
}

async function watchPiece(file: IFile, isVideo: boolean, start: number, seconds: number, transcript: AnalysisLine[] | null, dir: string): Promise<PieceResult> {
  const { bytes, mimeType } = await smallCopy(file.cdnUrl, isVideo, start, seconds, dir);
  const known = transcript?.filter((l) => l.end > start && l.start < start + seconds) ?? null;
  const transcriptNote = known
    ? `\n\nThe speech is already transcribed; leave "speech" empty. For reference (times from the start of this clip):\n${known
        .map((l) => `${clock(l.start - start)}–${clock(l.end - start)}${l.speaker ? ` [${l.speaker}]` : ''}: ${l.text}`)
        .join('\n')
        .slice(0, 20000)}`
    : '';
  const result = await getGeminiClient().generate({
    model: env.footageModel,
    fallback: env.aiModelFallback,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        text: `File name: "${file.name}". This clip is ${clock(seconds)} long.${isVideo ? '' : ' It is sound only: shots stay empty.'}${transcriptNote}`,
        media: [{ mimeType, data: bytes.toString('base64') }],
      },
    ],
    jsonSchema: PIECE_SCHEMA,
    thinking: 'low',
    timeoutMs: 180_000,
    patient: true,
  });
  const r = (result.json ?? {}) as Partial<MediaAnalysisResult>;
  const end = start + seconds;
  return {
    model: result.model ?? env.footageModel,
    result: {
      summary: String(r.summary || ''),
      kind: String(r.kind || 'other'),
      language: r.language ? String(r.language) : undefined,
      hasSpeech: !!r.hasSpeech,
      hasMusic: !!r.hasMusic,
      hasBurnedCaptions: !!r.hasBurnedCaptions,
      shots: (r.shots ?? []).map((x) => clampSpan(x as AnalysisShot, start, start, end)).filter((x): x is AnalysisShot => !!x),
      speech: (r.speech ?? []).map((x) => clampSpan(x as AnalysisLine, start, start, end)).filter((x): x is AnalysisLine => !!x),
      moments: (r.moments ?? [])
        .map((x) => clampSpan({ ...(x as AnalysisMoment), score: Math.max(1, Math.min(10, Math.round(Number((x as AnalysisMoment).score) || 5))) }, start, start, end))
        .filter((x): x is AnalysisMoment => !!x),
    },
  };
}

/** Seconds as M:SS.s */
const clock = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${(Math.max(0, t) % 60).toFixed(1).padStart(4, '0')}`;

async function runLimited<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    })
  );
  return results;
}

async function durationOf(file: IFile): Promise<number> {
  const known = Number((file.metadata as any)?.duration);
  if (known > 0) return known;
  const probe = await probeMedia(file.cdnUrl);
  return Number(probe.format?.duration) || 0;
}

async function analyse(file: IFile): Promise<IMediaAnalysis> {
  const isVideo = file.mimeType.startsWith('video/');
  const duration = await durationOf(file);
  if (!(duration > 0)) throw new Error('The file has no duration');
  const analysedSeconds = Math.min(duration, MAX_ANALYSED_SECONDS);

  const transcription = await Transcription.findOne({ fileId: file._id }).lean();
  const transcript = transcription?.words?.length ? transcriptLines(transcription.words as any) : null;

  const pieces: Array<[number, number]> = [];
  for (let s = 0; s < analysedSeconds; s += PIECE_SECONDS) pieces.push([s, Math.min(PIECE_SECONDS, analysedSeconds - s)]);
  // A sliver at the end goes with the piece before it
  if (pieces.length > 1 && pieces[pieces.length - 1][1] < 20) {
    const [, last] = pieces.pop()!;
    pieces[pieces.length - 1][1] += last;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'cue-footage-'));
  try {
    const watched = await runLimited(
      pieces.map(([s, len]) => () => watchPiece(file, isVideo, s, len, transcript, dir)),
      PARALLEL_PIECES
    );
    const all = watched.map((w) => w.result);
    const result: MediaAnalysisResult = {
      summary: all.map((r) => r.summary).filter(Boolean).join(' ').slice(0, 4000),
      kind: all[0]?.kind || 'other',
      language: transcription?.language || all.find((r) => r.language)?.language,
      hasSpeech: !!transcript?.length || all.some((r) => r.hasSpeech),
      hasMusic: all.some((r) => r.hasMusic),
      hasBurnedCaptions: all.some((r) => r.hasBurnedCaptions),
      shots: all.flatMap((r) => r.shots),
      speech: transcript ? transcript.filter((l) => l.start < analysedSeconds) : all.flatMap((r) => r.speech),
      moments: all.flatMap((r) => r.moments).sort((a, b) => b.score - a.score).slice(0, 40),
    };
    return await MediaAnalysis.findOneAndUpdate(
      { fileId: file._id, version: MEDIA_ANALYSIS_VERSION },
      {
        $set: {
          userId: file.userId,
          status: 'ready',
          analysedSeconds,
          duration,
          modelName: [...new Set(watched.map((w) => w.model))].join(', '),
          speechSource: transcript ? 'transcript' : result.speech.length ? 'model' : 'none',
          result,
        },
        $unset: { error: 1 },
      },
      { upsert: true, new: true }
    ).orFail();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const inFlight = new Map<string, Promise<IMediaAnalysis | null>>();

/**
 * What is in a video or audio file (null for pictures and other files).
 * Made once and kept; a second caller while it is being made waits for the
 * same result. Failures are recorded and not retried for a while.
 */
export async function footageAnalysis(fileId: string | Types.ObjectId, userId: string | Types.ObjectId): Promise<IMediaAnalysis | null> {
  const key = String(fileId);
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const file = await File.findOne({ _id: fileId, userId });
    if (!file || !/^(video|audio)\//.test(file.mimeType) || !file.cdnUrl) return null;
    const existing = await MediaAnalysis.findOne({ fileId: file._id, version: MEDIA_ANALYSIS_VERSION });
    if (existing?.status === 'ready') return existing;
    if (existing?.status === 'failed' && Date.now() - existing.updatedAt.getTime() < RETRY_FAILED_AFTER_MS) return existing;
    const started = Date.now();
    try {
      const done = await analyse(file);
      logger.info('Footage analysed', { fileId: key, seconds: done.analysedSeconds, ms: Date.now() - started, model: done.modelName });
      return done;
    } catch (error) {
      logger.warn('Footage analysis failed', { fileId: key, error: (error as Error).message });
      return MediaAnalysis.findOneAndUpdate(
        { fileId: file._id, version: MEDIA_ANALYSIS_VERSION },
        { $set: { userId: file.userId, status: 'failed', error: (error as Error).message.slice(0, 1000) } },
        { upsert: true, new: true }
      );
    }
  })();
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}
