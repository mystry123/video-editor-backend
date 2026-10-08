import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ITemplateVersion extends Document {
  _id: Types.ObjectId;
  templateId: Types.ObjectId;
  version: number;
  data: any;
  createdBy: Types.ObjectId;
  /** Why it was taken: autosave (every 5 min), render or leave. */
  reason?: string;
  createdAt: Date;
}

const TemplateVersionSchema = new Schema<ITemplateVersion>(
  {
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
    version: { type: Number, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String },
  },
  { timestamps: true }
);

TemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });

export const TemplateVersion = mongoose.model<ITemplateVersion>('TemplateVersion', TemplateVersionSchema);
