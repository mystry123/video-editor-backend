// services/templateVersion.service.ts
//
// Version history policy (decided 2026-10-08): autosave snapshots at most
// once per 5 minutes of editing; Render and "Save & leave" always snapshot;
// a restore keeps the state it replaces ('before-restore'); the latest 50
// snapshots per template are kept.

import { Types } from 'mongoose';
import { TemplateVersion } from '../models/TemplateVersion';
import { logger } from '../utils/logger';

export const SNAPSHOT_EVERY_MS = 5 * 60_000;
export const KEEP_VERSIONS = 50;

export type SnapshotReason = 'autosave' | 'render' | 'leave' | 'before-restore';

type SnapshotSource = { _id: any; version: number; data: unknown };

/**
 * Stores the template's current state as a version, if the policy says so.
 * Never throws: history is best-effort and must not fail a save or render.
 */
export async function snapshotTemplate(
  template: SnapshotSource,
  userId: string | Types.ObjectId,
  reason: SnapshotReason
): Promise<boolean> {
  try {
    if (reason === 'autosave') {
      const last = await TemplateVersion.findOne({ templateId: template._id }).sort({ createdAt: -1 }).select('createdAt').lean();
      if (last && Date.now() - new Date(last.createdAt).getTime() < SNAPSHOT_EVERY_MS) return false;
    }
    return await keepSnapshot(template, userId, reason);
  } catch (error: any) {
    logger.warn('Template snapshot failed', { templateId: String(template._id), reason, error: error?.message });
    return false;
  }
}

/**
 * Makes sure the template's current version has a snapshot, then trims the
 * history. Idempotent: an existing snapshot of this version (say, from a
 * Render) already holds this exact state and is kept as it is. Unlike
 * snapshotTemplate it throws on database errors, for callers (restore) that
 * must not go on without the snapshot. Resolves true if it stored a new one.
 */
export async function keepSnapshot(
  template: SnapshotSource,
  userId: string | Types.ObjectId,
  reason: SnapshotReason
): Promise<boolean> {
  // One snapshot per template version (unique index): a second Render of
  // the same version is already covered.
  const created = await TemplateVersion.updateOne(
    { templateId: template._id, version: template.version },
    { $setOnInsert: { data: template.data, createdBy: userId, reason } },
    { upsert: true }
  );
  if (!created.upsertedCount) return false;

  // Keep the newest KEEP_VERSIONS.
  const stale = await TemplateVersion.find({ templateId: template._id })
    .sort({ version: -1 })
    .skip(KEEP_VERSIONS)
    .select('_id')
    .lean();
  if (stale.length > 0) await TemplateVersion.deleteMany({ _id: { $in: stale.map((v) => v._id) } });
  return true;
}

export interface VersionSummary {
  /** The project's name, or null if it has none. */
  name: string | null;
  elementCount: number;
  /** Seconds: the project's duration, else where the last element ends. */
  duration: number;
  width: number | null;
  height: number | null;
  /** The snapshot's stored size in bytes. */
  size: number;
}

/** A number at `path`, or 0 if it's missing or not numeric. */
const numberOr0 = (path: string) => ({ $convert: { input: path, to: 'double', onError: 0, onNull: 0 } });
const numberOrNull = (path: string) => ({ $cond: [{ $isNumber: path }, path, null] });

/**
 * The newest `limit` snapshots without their data, each with the cheap facts
 * the history list shows. Computed in the database, so the snapshots' data
 * (megabytes each) never leaves it.
 */
export async function listVersionSummaries(templateId: Types.ObjectId, limit: number) {
  const elements = { $cond: [{ $isArray: '$data.elements' }, '$data.elements', []] };
  const storedDuration = numberOr0('$data.project.duration');
  const lastElementEnd = {
    $max: [0, { $max: { $map: { input: elements, as: 'e', in: { $add: [numberOr0('$$e.time'), numberOr0('$$e.duration')] } } } }],
  };
  return TemplateVersion.aggregate<{
    _id: Types.ObjectId;
    templateId: Types.ObjectId;
    version: number;
    reason?: string;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
    summary: VersionSummary;
  }>([
    { $match: { templateId } },
    { $sort: { version: -1 } },
    { $limit: limit },
    {
      $project: {
        templateId: 1,
        version: 1,
        reason: 1,
        createdBy: 1,
        createdAt: 1,
        updatedAt: 1,
        summary: {
          name: { $cond: [{ $eq: [{ $type: '$data.project.name' }, 'string'] }, '$data.project.name', null] },
          elementCount: { $size: elements },
          duration: { $cond: [{ $gt: [storedDuration, 0] }, storedDuration, lastElementEnd] },
          width: numberOrNull('$data.project.width'),
          height: numberOrNull('$data.project.height'),
          size: { $cond: [{ $eq: [{ $type: '$data' }, 'object'] }, { $bsonSize: '$data' }, 0] },
        },
      },
    },
  ]);
}
