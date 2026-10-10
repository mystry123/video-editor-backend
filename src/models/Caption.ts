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
  /** The full caption style from the editor (schemas/captionStyle) */
  style?: Record<string, unknown>;
  /** Where the caption sits (% of the frame), from the editor */
  placement?: { x?: string; y?: string; width?: string; height?: string };
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
  composition?: any;
  transcriptionStartedAt?: Date;
  transcriptionCompletedAt?: Date;
  generationStartedAt?: Date;
  generationCompletedAt?: Date;
  renderStartedAt?: Date;
  failedStage?: 'transcription' | 'generation' | 'rendering';
  cancelledAt?: Date;
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
  },
  // Pipeline state, so a retried job resumes instead of starting over (and
  // never starts a second render). These were written before but dropped by
  // the schema.
  composition: { type: Schema.Types.Mixed, select: false },
  transcriptionStartedAt: { type: Date },
  transcriptionCompletedAt: { type: Date },
  generationStartedAt: { type: Date },
  generationCompletedAt: { type: Date },
  renderStartedAt: { type: Date },
  /** Stage the project failed in: transcription, generation or rendering. */
  failedStage: { type: String, enum: ['transcription', 'generation', 'rendering'] },
  cancelledAt: { type: Date }
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

/** Statuses of a caption project that's still being worked on. */
export const ACTIVE_CAPTION_STATES = ['pending', 'transcribing', 'generating', 'rendering'];

export const CaptionProject = mongoose.model<ICaptionProject>('CaptionProject', CaptionProjectSchema);
