// services/director/learning.ts
//
// How Cue Director gets better from its own edits (prompt-level, not model
// weights):
//
//   1. distill   Runs since the last lesson set are read: the director's own
//                review issues and what users did with each draft (applied,
//                parts left out, undone, thumbs, exported). The strongest
//                model writes a new set of short craft rules per crew member
//                (at most 8 each, general, not about one video) and lists
//                problems that are code bugs (layout, rendering) for people:
//                bugs never become rules.
//   2. gate      The eval cases (DIRECTOR_EVAL_CASES: the owner's footage
//                and requests) are edited twice, with the live rules and with
//                the new ones, and an independent judge scores each edit.
//                The new set goes live only if it scores better; otherwise
//                it is rejected and the live set stays.
//
// It runs at most once a day, when there are enough new runs, started by
// the maintenance sweep (maybeLearn).

import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { DirectorRun } from '../../models/DirectorRun';
import { DirectorLessonSet, LESSON_CREW, type IDirectorLessonSet } from '../../models/DirectorLessonSet';
import { File } from '../../models/File';
import { User } from '../../models/User';
import { getGeminiClient } from '../ai/gemini';
import { forgetLessons, liveLessons, MAX_LESSONS, type Lessons } from './lessons';
import { judgeEdit } from './review';
import type { DirectorInput } from './run';

/** New finished runs needed before a new lesson set is written */
export const MIN_NEW_RUNS = 10;
const MAX_RUNS_READ = 80;
const DAY = 24 * 60 * 60 * 1000;
/** The candidate must beat the live set's mean judge score by this much */
export const GATE_MARGIN = 0.3;
/** A candidate still being gated after this long is given up */
const STUCK_GATE_MS = 4 * 60 * 60 * 1000;

export interface EvalCase {
  fileId: string;
  request: string;
}

/** The eval cases from the environment: [{ "fileId": "…", "request": "…" }] */
export function evalCases(): EvalCase[] {
  try {
    const list = JSON.parse(env.directorEvalCases || '[]');
    return Array.isArray(list) ? list.filter((c) => c?.fileId && c?.request).slice(0, 6) : [];
  } catch {
    return [];
  }
}

/** One run in words: what was asked, how the director judged it, what the user did */
export function runDigest(run: any): string {
  const b = run.brief ?? {};
  const reviews = (run.reviews ?? []) as any[];
  const o = run.outcome ?? {};
  const lines = [`Request: ${String(run.request).slice(0, 200)} → ${b.platform ?? '?'} ${b.aspect ?? ''} ${b.targetSeconds ?? '?'}s, ${b.tone ?? ''}`];
  for (const r of reviews) lines.push(`  Review ${r.round}: ${r.score}/10${(r.issues ?? []).map((i: any) => `\n    [${i.who}] ${String(i.problem).slice(0, 220)}`).join('')}`);
  const did = [
    o.applied ? `applied${o.leftOut?.length ? ` leaving out ${o.leftOut.join(', ')}` : ''}` : o.discarded ? 'discarded' : 'not used',
    o.undone && 'then undone',
    o.exported && 'then exported',
    o.rating === 1 && 'thumbs up',
    o.rating === -1 && `thumbs down${o.comment ? `: "${String(o.comment).slice(0, 200)}"` : ''}`,
  ].filter(Boolean);
  lines.push(`  User: ${did.join(', ')}`);
  return lines.join('\n');
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    lessons: {
      type: 'OBJECT',
      description: 'The full new rule set per crew member (keep good existing rules, drop ones the evidence contradicts)',
      properties: Object.fromEntries(LESSON_CREW.map((c) => [c, { type: 'ARRAY', items: { type: 'STRING' } }])),
    },
    bugs: { type: 'ARRAY', items: { type: 'OBJECT', properties: { problem: { type: 'STRING' }, evidence: { type: 'INTEGER' } }, required: ['problem', 'evidence'] } },
    note: { type: 'STRING', description: 'What changed and why, briefly' },
  },
  required: ['lessons', 'bugs', 'note'],
};

/** Writes a candidate lesson set from the runs since the last set (null when there aren't enough) */
export async function distillLessons(): Promise<IDirectorLessonSet | null> {
  const last = await DirectorLessonSet.findOne({ status: { $in: ['live', 'rejected', 'retired'] } }).sort({ createdAt: -1 }).lean();
  const since = last?.createdAt ?? new Date(Date.now() - 30 * DAY);
  const runs = await DirectorRun.find({ stage: 'done', createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(MAX_RUNS_READ).select('request brief reviews outcome').lean();
  if (runs.length < MIN_NEW_RUNS) return null;
  const live = await liveLessons();
  const system = `You run quality for an AI video-editing crew: director (brief), story (cut), type (titles, captions), motion (moves, transitions, framing), sound, assets (B-roll). Below are recent edits: how the director's own reviews judged each draft, and what the user did with it (applied, parts left out, undone, exported, thumbs).
Write the crew's rule set for future edits: short, imperative, general craft rules (never about one specific video), at most ${MAX_LESSONS} per member, each under 160 characters, the most important first. A rule needs evidence from several edits or a clear user signal (parts users keep leaving out, thumbs-down notes, undone edits). Keep current rules that still hold; drop ones the evidence contradicts.
Some problems are not craft but software (text drawn outside its box, wrong crop maths, missing frames, broken timing): list those under bugs for engineers, never as rules.`;
  const text = `CURRENT RULES\n${JSON.stringify(live, null, 1)}\n\nRECENT EDITS (${runs.length})\n${runs.map(runDigest).join('\n\n').slice(0, 120_000)}`;
  const result = await getGeminiClient().generate({ model: env.directorModel, fallback: env.aiModelStrong, system, messages: [{ role: 'user', text }], jsonSchema: SCHEMA, thinking: 'high', timeoutMs: 180_000, patient: true });
  const out = (result.json ?? {}) as { lessons?: Lessons; bugs?: Array<{ problem: string; evidence: number }>; note?: string };
  const lessons: Lessons = {};
  for (const c of LESSON_CREW) {
    const rules = (out.lessons?.[c] ?? []).map((r) => String(r).trim().slice(0, 200)).filter(Boolean).slice(0, MAX_LESSONS);
    if (rules.length) lessons[c] = rules;
  }
  return DirectorLessonSet.create({
    status: 'candidate',
    lessons,
    bugs: (out.bugs ?? []).slice(0, 30).map((b) => ({ problem: String(b.problem).slice(0, 500), evidence: Math.max(1, Math.round(Number(b.evidence) || 1)) })),
    basedOnRuns: runs.length,
    note: String(out.note || '').slice(0, 2000),
  });
}

/** Edits one eval case with the given lessons and returns the judge's score (null if it couldn't be made) */
async function scoreCase(user: any, c: EvalCase, lessons: Lessons, key: string): Promise<number | null> {
  const { directEdit } = await import('./run');
  const file = await File.findOne({ _id: c.fileId, userId: user._id }).lean();
  if (!file) return null;
  const meta = (file.metadata ?? {}) as any;
  const duration = Number(meta.duration) || 10;
  const input: DirectorInput = {
    projectId: `eval-${key}`,
    request: c.request,
    conversation: [],
    context: `Project: ${meta.width || 1920}x${meta.height || 1080}, 30fps\nc1 ${file.mimeType.startsWith('audio/') ? 'audio' : 'video'} "${file.name}" · T1 · 0:00.0–${duration}`,
    project: {
      project: { name: 'eval', width: Number(meta.width) || 1920, height: Number(meta.height) || 1080, fps: 30, duration, backgroundColor: '#000000' },
      elements: [{ id: 'v1', type: file.mimeType.startsWith('audio/') ? 'audio' : 'video', name: file.name, source: file.cdnUrl, fileId: String(file._id), track: 1, time: 0, duration, x: '50%', y: '50%', width: '100%', height: '100%', volume: 100, visible: true }],
    },
  };
  try {
    const { result } = await directEdit({ user, input, key, report: async () => undefined, lessons });
    const verdict = await judgeEdit(result, c.request);
    return verdict?.overall ?? null;
  } catch (error) {
    logger.warn('Director eval case failed', { key, error: (error as Error).message });
    return null;
  }
}

/** Runs the eval gate on a candidate set: it goes live only if it scores better than the live set */
export async function gateCandidate(candidate: IDirectorLessonSet): Promise<IDirectorLessonSet> {
  const cases = evalCases();
  const owner = env.directorEvalUser && Types.ObjectId.isValid(env.directorEvalUser) ? await User.findById(env.directorEvalUser) : null;
  if (!cases.length || !owner) {
    candidate.status = 'rejected';
    candidate.note = `${candidate.note ?? ''}\n(No eval cases configured: DIRECTOR_EVAL_USER and DIRECTOR_EVAL_CASES. Not promoted.)`.trim();
    return candidate.save();
  }
  const live = await liveLessons();
  const liveScores: number[] = [];
  const candidateScores: number[] = [];
  // One case at a time, both arms: fair against the same Vertex load
  for (const [i, c] of cases.entries()) {
    const a = await scoreCase(owner, c, live, `${candidate._id}-${i}-live`);
    const b = await scoreCase(owner, c, candidate.lessons as Lessons, `${candidate._id}-${i}-new`);
    if (a !== null && b !== null) {
      liveScores.push(a);
      candidateScores.push(b);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  const gate = { live: mean(liveScores), candidate: mean(candidateScores), cases: liveScores.length, at: new Date() };
  const better = gate.cases >= Math.min(2, cases.length) && gate.candidate >= gate.live + GATE_MARGIN;
  candidate.gate = gate;
  candidate.status = better ? 'live' : 'rejected';
  await candidate.save();
  if (better) {
    await DirectorLessonSet.updateMany({ status: 'live', _id: { $ne: candidate._id } }, { $set: { status: 'retired' } });
    forgetLessons();
  }
  logger.info('Director lessons gated', { setId: String(candidate._id), ...gate, promoted: better });
  return candidate;
}

let learning = false;

/**
 * Called by the maintenance sweep: once a day at most, when there are
 * enough new runs, writes a candidate set and gates it (in the background).
 */
export async function maybeLearn(): Promise<void> {
  if (learning || !env.directorLearning) return;
  // A gate that never finished (a restart) is given up
  await DirectorLessonSet.updateMany({ status: 'candidate', createdAt: { $lt: new Date(Date.now() - STUCK_GATE_MS) } }, { $set: { status: 'rejected', note: 'Gate did not finish' } });
  if (await DirectorLessonSet.exists({ status: 'candidate' })) return;
  const latest = await DirectorLessonSet.findOne().sort({ createdAt: -1 }).select('createdAt').lean();
  if (latest && Date.now() - latest.createdAt.getTime() < DAY) return;
  learning = true;
  void (async () => {
    try {
      const candidate = await distillLessons();
      if (candidate) await gateCandidate(candidate);
    } catch (error) {
      logger.error('Director learning failed', { error: (error as Error).message });
    } finally {
      learning = false;
    }
  })();
}
