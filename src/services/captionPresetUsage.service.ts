// Counting caption style uses: once per user, preset and project.

import { Types } from 'mongoose';
import { CaptionPreset } from '../models/CaptionPreset';
import { CaptionPresetUse } from '../models/CaptionPresetUse';

const DUPLICATE_KEY = 11000;

/**
 * Record that `userId` used preset `presetId` in `projectKey`. Returns true
 * when it's a new use (and the preset's count went up), false when it was
 * already recorded.
 */
export async function recordPresetUse(presetId: string | Types.ObjectId, userId: string | Types.ObjectId, projectKey: string): Promise<boolean> {
  try {
    await CaptionPresetUse.create({ presetId, userId, projectKey: projectKey.slice(0, 100) });
  } catch (error: any) {
    if (error?.code === DUPLICATE_KEY) return false;
    throw error;
  }
  await CaptionPreset.updateOne({ _id: presetId }, { $inc: { usageCount: 1 } });
  return true;
}
