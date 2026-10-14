// services/director/taste.ts
//
// What Cue Director knows about this user from their own past runs (never
// other people's): parts they keep leaving out or that they thumbed down
// (their taste, as rules for the crew member concerned), and their best
// edits (applied and kept, exported or thumbed up) as worked examples for
// the director's brief.

import { Types } from 'mongoose';
import { DirectorRun } from '../../models/DirectorRun';
import type { Lessons } from './lessons';

const LOOKBACK = 90 * 24 * 60 * 60 * 1000;
/** A part left out in at least this share of (at least MIN_APPLIED) applied edits is a taste */
const LEFT_OUT_SHARE = 0.6;
const MIN_APPLIED = 3;

const GROUP_CREW: Record<string, { crew: keyof Lessons; words: string }> = {
  sound: { crew: 'sound', words: 'sound effects' },
  music: { crew: 'sound', words: 'music' },
  titles: { crew: 'type', words: 'titles' },
  captions: { crew: 'type', words: 'captions' },
  motion: { crew: 'motion', words: 'camera moves' },
  cutaways: { crew: 'story', words: 'cutaways over speech' },
  extras: { crew: 'assets', words: 'B-roll pictures' },
};

export interface Taste {
  /** Rules from this user's own habits, per crew member */
  lessons: Lessons;
  /** Their best past edits, in words, for the brief */
  examples: string[];
}

export async function userTaste(userId: string | Types.ObjectId): Promise<Taste> {
  const runs = await DirectorRun.find({ userId, stage: 'done', createdAt: { $gt: new Date(Date.now() - LOOKBACK) } })
    .sort({ createdAt: -1 })
    .limit(40)
    .select('request brief reviews outcome')
    .lean();
  const lessons: Lessons = {};
  const add = (crew: keyof Lessons, rule: string) => (lessons[crew] ??= []).push(rule);

  const applied = runs.filter((r) => r.outcome?.applied && !r.outcome?.undone);
  if (applied.length >= MIN_APPLIED) {
    for (const [group, { crew, words }] of Object.entries(GROUP_CREW)) {
      const left = applied.filter((r) => r.outcome?.leftOut?.includes(group)).length;
      if (left / applied.length >= LEFT_OUT_SHARE) add(crew, `This user usually leaves out ${words} (${left} of their last ${applied.length} edits): use them sparingly, or not at all.`);
    }
  }
  const notes = runs.filter((r) => r.outcome?.rating === -1 && r.outcome?.comment).slice(0, 4);
  if (notes.length) add('director', `This user's recent complaints about edits: ${notes.map((r) => `"${String(r.outcome!.comment).slice(0, 160)}"`).join('; ')}. Avoid repeating them.`);

  const best = runs
    .filter((r) => !r.outcome?.undone && (r.outcome?.exported || r.outcome?.rating === 1))
    .slice(0, 2)
    .map((r: any) => {
      const b = r.brief ?? {};
      const beats = (b.structure ?? []).map((s: any) => `${s.beat} ${s.seconds}s`).join(' → ');
      return `"${String(r.request).slice(0, 120)}" → ${b.platform ?? ''} ${b.aspect ?? ''} ${b.targetSeconds ?? ''}s, ${b.tone ?? ''}; hook: ${String(b.hook ?? '').slice(0, 160)}; beats: ${beats}${r.outcome?.exported ? ' (they exported it)' : ' (they liked it)'}`;
    });
  return { lessons, examples: best };
}

/** Shared rules plus this user's own, theirs first (they know what they like) */
export function withTaste(shared: Lessons, taste: Taste): Lessons {
  const out: Lessons = { ...shared };
  for (const [crew, rules] of Object.entries(taste.lessons) as Array<[keyof Lessons, string[]]>) out[crew] = [...rules, ...(shared[crew] ?? [])];
  return out;
}
