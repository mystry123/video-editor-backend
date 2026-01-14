import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IWebhook extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  successCount: number;
  failCount: number;
  lastTriggered?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WebhookSchema = new Schema<IWebhook>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    secret: { type: String, required: true },
    events: [{ type: String }],
    isActive: { type: Boolean, default: true },
    successCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
    lastTriggered: { type: Date },
  },
  { timestamps: true }
);

export const Webhook = mongoose.model<IWebhook>('Webhook', WebhookSchema);
