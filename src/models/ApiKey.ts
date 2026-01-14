import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IApiKey extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  key: string;
  keyPrefix: string;
  permissions: string[];
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    key: { type: String, required: true, unique: true, index: true },
    keyPrefix: { type: String, required: true },
    permissions: [{ type: String }],
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

export const ApiKey = mongoose.model<IApiKey>('ApiKey', ApiKeySchema);
