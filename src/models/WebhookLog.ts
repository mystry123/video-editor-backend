import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IWebhookLog extends Document {
  _id: Types.ObjectId;
  webhookId: Types.ObjectId;
  event: string;
  payload: any;
  response?: any;
  statusCode?: number;
  success: boolean;
  error?: string;
  createdAt: Date;
}

const WebhookLogSchema = new Schema<IWebhookLog>(
  {
    webhookId: { type: Schema.Types.ObjectId, ref: 'Webhook', required: true, index: true },
    event: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    response: { type: Schema.Types.Mixed },
    statusCode: { type: Number },
    success: { type: Boolean, required: true },
    error: { type: String },
  },
  { timestamps: true }
);

// Auto-delete logs after 30 days
WebhookLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const WebhookLog = mongoose.model<IWebhookLog>('WebhookLog', WebhookLogSchema);
