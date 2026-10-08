// models/Plan.ts
//
// One document per plan key (free/pro/team/admin — the same values as
// User.role). `limits` holds a UserQuota; fields missing from an older
// document fall back to the defaults in config/quotas.ts when read.

import mongoose, { Schema, Document } from 'mongoose';
import type { UserQuota } from '../config/quotas';

export interface IPlan extends Document {
  key: string;
  name: string;
  description?: string;
  limits: Partial<UserQuota>;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PlanSchema = new Schema<IPlan>(
  {
    key: { type: String, required: true, unique: true, enum: ['free', 'pro', 'team', 'admin'] },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300 },
    limits: { type: Schema.Types.Mixed, required: true, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false }
);

export const Plan = mongoose.model<IPlan>('Plan', PlanSchema);
