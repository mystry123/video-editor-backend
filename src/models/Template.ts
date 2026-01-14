import mongoose, { Schema, Document, Types } from 'mongoose';
import { TemplateData } from '../types';

export interface ITemplate extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  description?: string;
  thumbnail?: string;
  data: TemplateData;
  isPublic: boolean;
  tags: string[];
  category?: string;
  version: number;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const TemplateSchema = new Schema<ITemplate>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    description: { type: String },
    thumbnail: { type: String },
    data: {
      project: {
        width: { type: Number, default: 1920 },
        height: { type: Number, default: 1080 },
        name: { type: String, default: 'New Project' },
        fps: { type: Number, default: 30 },
        duration: { type: Number, default: 10 },
        backgroundColor: { type: String, default: '#000000' },
        outputFormat: { type: String },
        selectedVoice: { type: String },
      },
      elements: { type: Schema.Types.Mixed, default: [] },
    },
    isPublic: { type: Boolean, default: false, index: true },
    tags: { type: [String], index: true },
    category: { type: String },
    version: { type: Number, default: 1 },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Text search index
TemplateSchema.index({ name: 'text', description: 'text' });

export const Template = mongoose.model<ITemplate>('Template', TemplateSchema);
