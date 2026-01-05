import mongoose, { Schema, Document } from 'mongoose';

export interface IFile extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  cdnUrl: string;
  thumbnailKey?: string;      // Add
  thumbnailUrl?: string;
  status: 'processing' | 'ready' | 'failed' | 'deleted';
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const FileSchema = new Schema<IFile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    storageKey: { type: String, required: true, unique: true },
    cdnUrl: { type: String, required: true },
    thumbnailKey: {type: String},     // Add
    thumbnailUrl: { type: String },
    status: {
      type: String,
      enum: ['processing', 'ready', 'failed', 'deleted'],
      default: 'processing',
    },
    metadata: {
      width: Number,
      height: Number,
      duration: Number,
    },
  },
  { timestamps: true }
);

export const File = mongoose.model<IFile>('File', FileSchema);