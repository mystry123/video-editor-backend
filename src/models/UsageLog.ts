import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUsageLog extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  action: string;
  quantity: number;
  cost?: number;
  metadata?: any;
  createdAt: Date;
}

const UsageLogSchema = new Schema<IUsageLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true, index: true },
    quantity: { type: Number, required: true },
    cost: { type: Number },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

UsageLogSchema.index({ userId: 1, createdAt: -1 });

export const UsageLog = mongoose.model<IUsageLog>('UsageLog', UsageLogSchema);
