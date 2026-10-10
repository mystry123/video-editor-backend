// One record per (preset, user, project) that used a caption style. The
// preset's usageCount goes up only when a new record is made, so it counts
// real uses: it used to go up on every render of a captions-page project
// and on every call to /use (any user, any number of times). Kept with a
// time so trending (uses in the last days) can be computed.

import { Schema, model, Types, type Document, type Model } from 'mongoose';

export interface ICaptionPresetUse extends Document {
  presetId: Types.ObjectId;
  userId: Types.ObjectId;
  /** What it was used in (a template or captions-page project id) */
  projectKey: string;
  createdAt: Date;
}

const CaptionPresetUseSchema = new Schema<ICaptionPresetUse>(
  {
    presetId: { type: Schema.Types.ObjectId, ref: 'CaptionPreset', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectKey: { type: String, required: true, maxlength: 100 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CaptionPresetUseSchema.index({ presetId: 1, userId: 1, projectKey: 1 }, { unique: true });
// Trending: recent uses per preset
CaptionPresetUseSchema.index({ createdAt: -1, presetId: 1 });

export const CaptionPresetUse: Model<ICaptionPresetUse> = model<ICaptionPresetUse>('CaptionPresetUse', CaptionPresetUseSchema);
