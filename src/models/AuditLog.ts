// models/AuditLog.ts
//
// Append-only record of admin changes (plan edits, a user's plan or limit
// overrides). Never updated or deleted by the app.

import mongoose, { Schema, Document, Types } from 'mongoose';

export type AuditAction =
  | 'plan.update'
  | 'user.plan.change'
  | 'user.override.add'
  | 'user.override.remove';

export interface IAuditLog extends Document {
  actorId: Types.ObjectId;
  actorEmail: string;
  action: AuditAction;
  targetType: 'plan' | 'user';
  targetId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, enum: ['plan', 'user'], required: true },
    targetId: { type: String, required: true },
    summary: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
