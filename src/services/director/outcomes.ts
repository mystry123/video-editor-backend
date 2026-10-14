// services/director/outcomes.ts
//
// What users do with Director drafts: applied or discarded, which parts they
// left out, undone soon after, rated, exported. These are the signals the
// Director learns from (see lessons.ts) besides its own reviews.

import { Types } from 'mongoose';
import { DirectorRun } from '../../models/DirectorRun';
import { logger } from '../../utils/logger';

export type OutcomeEvent =
  | { event: 'applied'; leftOut?: string[] }
  | { event: 'discarded' }
  | { event: 'undone' }
  | { event: 'rated'; rating: 1 | -1; comment?: string };

export async function recordOutcome(runId: string, userId: string | Types.ObjectId, outcome: OutcomeEvent): Promise<boolean> {
  const now = new Date();
  const set: Record<string, unknown> =
    outcome.event === 'applied'
      ? { 'outcome.applied': now, 'outcome.leftOut': (outcome.leftOut ?? []).slice(0, 12) }
      : outcome.event === 'discarded'
        ? { 'outcome.discarded': now }
        : outcome.event === 'undone'
          ? { 'outcome.undone': now }
          : { 'outcome.rating': outcome.rating, ...(outcome.comment ? { 'outcome.comment': outcome.comment.slice(0, 1000) } : {}) };
  const done = await DirectorRun.updateOne({ _id: runId, userId, stage: 'done' }, { $set: set });
  return done.matchedCount > 0;
}

/** A render of a project marks its latest applied Director edit (last 7 days) as exported */
export async function markDirectorExport(userId: string | Types.ObjectId, projectId: string): Promise<void> {
  try {
    const run = await DirectorRun.findOne({
      userId,
      projectId,
      'outcome.applied': { $exists: true },
      'outcome.undone': { $exists: false },
      'outcome.exported': { $exists: false },
      createdAt: { $gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: -1 })
      .select('_id');
    if (run) await DirectorRun.updateOne({ _id: run._id }, { $set: { 'outcome.exported': new Date() } });
  } catch (error) {
    logger.warn('Could not mark a Director edit exported', { projectId, error: (error as Error).message });
  }
}
