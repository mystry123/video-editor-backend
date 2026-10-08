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
  /** "v2" for the reframe engine service; absent for the old YOLO path. */
  engine?: string;
  analysisId?: string;
  /** Current analysis stage while processing (e.g. "Tracking people") and 0..1 progress. */
  stage?: string;
  progress?: number;
  quality?: string;
  /** Options this result was planned with: zoom, keepText. */
  options?: unknown;
  /** Engine v2 plan: segments, overlays, notes, speakers, settings, source. */
  result?: unknown;
  /** Burned-in text found in the video, for the keep-or-drop question. */
  text?: unknown[];
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
  /** Latest reframe engine analysis of this file, reused for every shape. */
  reframeAnalysis?: { id: string; quality: string; transcriptAt?: Date | null };
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
    reframeAnalysis: {
      id: { type: String },
      quality: { type: String },
      transcriptAt: { type: Date },
    },
    // AI Reframe data — keyed by aspect ratio (e.g., "9_16", "1_1", "4_5")
    reframe: {
      type: Map,
      of: new Schema({
        status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
        engine: { type: String },
        analysisId: { type: String },
        stage: { type: String },
        progress: { type: Number },
        quality: { type: String },
        options: { type: Schema.Types.Mixed },
        result: { type: Schema.Types.Mixed },
        text: [{ type: Schema.Types.Mixed }],
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