import mongoose, { Schema, Document } from 'mongoose';

export interface IFileMetadata {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** Set when ffprobe couldn't read the file; the other fields are then unknown (0). */
  metadataError?: string;
}

export interface IReframeData {
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  layoutDecision?: unknown;
  zones?: unknown[];
  sceneStats?: unknown;
  fps?: number;
  videoWidth?: number;
  videoHeight?: number;
  error?: string;
  processedAt?: Date;
}

export interface IFile extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  cdnUrl: string;
  thumbnailKey?: string;
  thumbnailUrl?: string;
  status: 'processing' | 'ready' | 'failed' | 'deleted';
  metadata?: IFileMetadata;
  // New fields for import functionality
  source: 'upload' | 'url' | 'google_drive';
  sourceUrl?: string;
  sourceId?: string;
  importProgress?: number;
  importError?: string;
  reframe?: Map<string, IReframeData>;
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
    thumbnailKey: { type: String },
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
      hasAudio: Boolean,
      metadataError: String,
    },
    // New fields for import functionality
    source: {
      type: String,
      enum: ['upload', 'url', 'google_drive'],
      default: 'upload',
    },
    sourceUrl: { type: String },
    sourceId: { type: String },
    importProgress: { type: Number, default: 0 },
    importError: { type: String },
    // AI Reframe data — keyed by aspect ratio (e.g., "9_16", "1_1", "4_5")
    reframe: {
      type: Map,
      of: new Schema({
        status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
        layoutDecision: { type: Schema.Types.Mixed },
        zones: [{ type: Schema.Types.Mixed }],
        sceneStats: { type: Schema.Types.Mixed },
        fps: { type: Number },
        videoWidth: { type: Number },
        videoHeight: { type: Number },
        error: { type: String },
        processedAt: { type: Date },
      }, { _id: false }),
    },
  },
  { timestamps: true }
);

// Index for efficient queries
FileSchema.index({ userId: 1, status: 1 });
FileSchema.index({ userId: 1, createdAt: -1 });

export const File = mongoose.model<IFile>('File', FileSchema);