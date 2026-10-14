// services/director/lessons.ts
//
// The rules Cue Director's crew follows from past edits (the live
// DirectorLessonSet), cached briefly. learning.ts writes new sets and
// decides whether they go live.

import { DirectorLessonSet, type LessonCrew } from '../../models/DirectorLessonSet';
import { logger } from '../../utils/logger';

export type Lessons = Partial<Record<LessonCrew, string[]>>;

/** Rules per crew member in a prompt, at most */
export const MAX_LESSONS = 8;
const CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; lessons: Lessons } | null = null;

export async function liveLessons(): Promise<Lessons> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.lessons;
  try {
    const live = await DirectorLessonSet.findOne({ status: 'live' }).sort({ updatedAt: -1 }).lean();
    cached = { at: Date.now(), lessons: (live?.lessons as Lessons) ?? {} };
  } catch (error) {
    logger.warn('Could not load Director lessons', { error: (error as Error).message });
    cached = { at: Date.now(), lessons: {} };
  }
  return cached.lessons;
}

/** Tests, and after a new set goes live */
export function forgetLessons() {
  cached = null;
}

/** The lessons for one crew member, as a prompt block (empty when none) */
export function lessonBlock(rules: string[] | undefined): string {
  const list = (rules ?? []).filter(Boolean).slice(0, MAX_LESSONS);
  return list.length ? `\n\nLESSONS FROM PAST EDITS (follow them unless the brief or request says otherwise)\n- ${list.join('\n- ')}` : '';
}
