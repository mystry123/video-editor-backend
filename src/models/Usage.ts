// models/Usage.ts
//
// Metered usage. Each metered job has one UsageEntry (keyed by kind + jobId)
// that goes reserved → settled (charged) or reserved → released (refunded).
// UsageCounter holds the month's running total per user and kind; reserving
// is a single conditional $inc on it, so concurrent requests can't overshoot
// a limit. Amounts are seconds for the *Minutes kinds and counts otherwise.

import mongoose, { Schema, Document, Types } from 'mongoose';

export type UsageKind = 'renderMinutes' | 'captionRenderMinutes' | 'transcriptionMinutes' | 'captionExports';
export type UsageState = 'reserved' | 'settled' | 'released';

export interface IUsageCounter extends Document {
  userId: Types.ObjectId;
  kind: UsageKind;
  /** UTC month, "YYYY-MM". */
  period: string;
  total: number;
}

const UsageCounterSchema = new Schema<IUsageCounter>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, required: true },
    period: { type: String, required: true },
    total: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);
UsageCounterSchema.index({ userId: 1, kind: 1, period: 1 }, { unique: true });

export interface IUsageEntry extends Document {
  userId: Types.ObjectId;
  kind: UsageKind;
  jobId: string;
  period: string;
  amount: number;
  state: UsageState;
  reason?: string;
  settledAt?: Date;
  releasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UsageEntrySchema = new Schema<IUsageEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, required: true },
    jobId: { type: String, required: true },
    period: { type: String, required: true },
    amount: { type: Number, required: true },
    state: { type: String, enum: ['reserved', 'settled', 'released'], required: true },
    reason: { type: String },
    settledAt: { type: Date },
    releasedAt: { type: Date },
  },
  { timestamps: true }
);
UsageEntrySchema.index({ kind: 1, jobId: 1 }, { unique: true });
UsageEntrySchema.index({ userId: 1, period: 1, kind: 1 });
UsageEntrySchema.index({ state: 1, updatedAt: 1 });

export const UsageCounter = mongoose.model<IUsageCounter>('UsageCounter', UsageCounterSchema, 'usage_counters');
export const UsageEntry = mongoose.model<IUsageEntry>('UsageEntry', UsageEntrySchema, 'usage_entries');
