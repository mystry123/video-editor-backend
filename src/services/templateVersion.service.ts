// services/templateVersion.service.ts
//
// Version history policy (decided 2026-10-08): autosave snapshots at most
// once per 5 minutes of editing; Render and "Save & leave" always snapshot;
// the latest 50 snapshots per template are kept.

import { Types } from 'mongoose';
import { TemplateVersion } from '../models/TemplateVersion';
import { logger } from '../utils/logger';

export const SNAPSHOT_EVERY_MS = 5 * 60_000;
export const KEEP_VERSIONS = 50;

export type SnapshotReason = 'autosave' | 'render' | 'leave';

/**
 * Stores the template's current state as a version, if the policy says so.
 * Never throws: history is best-effort and must not fail a save or render.
 */
export async function snapshotTemplate(
  template: { _id: any; version: number; data: unknown },
  userId: string | Types.ObjectId,
  reason: SnapshotReason
): Promise<boolean> {
  try {
    if (reason === 'autosave') {
      const last = await TemplateVersion.findOne({ templateId: template._id }).sort({ createdAt: -1 }).select('createdAt').lean();
      if (last && Date.now() - new Date(last.createdAt).getTime() < SNAPSHOT_EVERY_MS) return false;
    }
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
  } catch (error: any) {
    logger.warn('Template snapshot failed', { templateId: String(template._id), reason, error: error?.message });
    return false;
  }
}
