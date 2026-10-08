// models/Session.ts
//
// One document per signed-in device. The refresh token in the browser is
// tied to this document by its id (`sid` in the JWT) and its hash. Each
// refresh rotates the token; presenting an older token after the short grace
// window means it was copied, and the whole session is revoked.

import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ISession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** sha256 of the current refresh token. */
  tokenHash: string;
  /** Previous token, still accepted until prevValidUntil (parallel requests during a rotation). */
  prevTokenHash?: string;
  prevValidUntil?: Date;
  /** The current token, encrypted, so a request inside the grace window gets the same rotation result. */
  pendingToken?: string;
  method: string;
  userAgent?: string;
  ip?: string;
  device?: string;
  location?: string | null;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string;
  createdAt: Date;
}

const SessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, index: true },
    prevTokenHash: { type: String },
    prevValidUntil: { type: Date },
    pendingToken: { type: String, select: false },
    method: { type: String, required: true },
    userAgent: { type: String },
    ip: { type: String },
    device: { type: String },
    location: { type: String, default: null },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Mongo removes sessions once they can no longer be refreshed.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SessionSchema.index({ userId: 1, revokedAt: 1, lastUsedAt: -1 });

export const Session = mongoose.model<ISession>('Session', SessionSchema);
