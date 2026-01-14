import mongoose, { Schema, Document, Types } from 'mongoose';

// ============================================================================
// Types
// ============================================================================

export type CaptionProjectStatus = 
  | 'pending'
  | 'transcribing' 
  | 'generating'
  | 'rendering'
  | 'completed'
  | 'failed';

export interface CaptionSettings {
  fontSize?: number;
  wordsPerLine?: number;
  linesPerPage?: number;
  position?: "top" | "bottom" | "center";
  highlightColor?: string;
  inactiveColor?: string;
  upcomingColor?: string;
  inactiveOpacity?: number;
  upcomingOpacity?: number;
  backgroundColor?: string;
  backgroundXPadding?: number;
  backgroundYPadding?: number;
  backgroundBorderRadius?: number;
  outputFormat?: "mp4" | "webm" | "mov";
}

export interface ICaptionProject extends Document {
  userId: Types.ObjectId;
  fileId: Types.ObjectId;
  presetId?: Types.ObjectId;
  transcriptionId?: Types.ObjectId;
  renderJobId?: Types.ObjectId;
  name: string;
  status: CaptionProjectStatus;
  progress: number;
  settings?: CaptionSettings;
  outputUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  renderCompletedAt?: Date;
}

// ============================================================================
// Schema
// ============================================================================

const CaptionProjectSchema = new Schema<ICaptionProject>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  fileId: {
    type: Schema.Types.ObjectId,
    ref: 'File',
    required: true,
    index: true
  },
  presetId: {
    type: Schema.Types.ObjectId,
    ref: 'CaptionPreset'
  },
  transcriptionId: {
    type: Schema.Types.ObjectId,
    ref: 'Transcription'
  },
  renderJobId: {
    type: Schema.Types.ObjectId,
    ref: 'RenderJob'
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255
  },
  status: {
    type: String,
    enum: ['pending', 'transcribing', 'generating', 'rendering', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  settings: {
    type: Schema.Types.Mixed
  },
  outputUrl: {
    type: String,
    trim: true
  },
  thumbnailUrl: {
    type: String,
    trim: true
  },
  error: {
    type: String,
    trim: true
  },
  renderCompletedAt: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'captionprojects'
});

// Indexes for better query performance
CaptionProjectSchema.index({ userId: 1, createdAt: -1 });
CaptionProjectSchema.index({ status: 1, createdAt: -1 });

// ============================================================================
// Model
// ============================================================================

export const CaptionProject = mongoose.model<ICaptionProject>('CaptionProject', CaptionProjectSchema);
