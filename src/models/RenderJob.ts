// models/RenderJob.ts

import { randomBytes } from 'crypto';
import mongoose, { Schema, Document, Types } from 'mongoose';

export type RenderStatus = 'pending' | 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled';

export interface IRenderJob extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  templateId?: Types.ObjectId;
  /** Template version this render was taken from. */
  templateVersion?: number;
  /** Client-chosen key: the same key returns the same job instead of starting another. */
  idempotencyKey?: string;
  /** Token in the render's Shotline link (/r/<id>?t=...). Hidden by default. */
  shareToken?: string;
  /** Where the (private) output file is stored. */
  outputBucket?: string;
  outputKey?: string;
  /** When progress was last read from Lambda. */
  lastProgressAt?: Date;
  captionProjectId?: Types.ObjectId;
  inputProps: any;
  outputFormat: string;
  resolution: string;
  /** Remotion output scale; < 1 when the plan caps resolution below the project's. */
  scale: number;
  fps: number;
  renderType: "Template" | "CaptionProject"
  renderId?: string;
  outputUrl?: string;
  thumbnailUrl?: string;
  status: RenderStatus;
  progress: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Internal fields (hidden from frontend)
  bucketName?: string;
  serveUrl?: string;
  webhookUrl?: string;
  webhookSent: boolean;
  variables?: Record<string, unknown>;
  
  // Cost fields
  estimatedCost?: number;
  actualCost?: number;
  costDisplay?: string;
  currency?: string;
  
  // Render metrics
  framesRendered?: number;
  chunks?: number;
  timeToRenderFrames?: number;
  timeToFinish?: number;
  timeToFinishChunks?: number;
  timeToEncode?: number;
  timeToCombine?: number;
  combinedFrames?: number;
  lambdasInvoked?: number;
  outputSizeInBytes?: number;
  estimatedBillingDurationInMilliseconds?: number;
  
  // Status flags
  fatalErrorEncountered?: boolean;
  compositionValidated?: number; // Changed from boolean to number (timestamp)
  functionLaunched?: number; // Changed from boolean to number (timestamp)
  serveUrlOpened?: number; // Changed from boolean to number (timestamp)
  timeoutTimestamp?: number;
  
  // Additional data
  renderSize?: number;
  currentTime?: number;
  type?: string;
  outKey?: string;
  outBucket?: string;
  artifacts?: any[];
  renderMetadata?: any;
  encodingStatus?: {
    framesEncoded: number;
    combinedFrames: number;
    timeToCombine: number | null;
  };
  cleanup?: any;
  mostExpensiveFrameRanges?: any[];
  renderErrors?: any[];
}

/** Same as renderOutput.service's newShareToken (kept here to avoid a model → service import). */
const newShareToken = () => randomBytes(24).toString('base64url');

const RenderJobSchema = new Schema<IRenderJob>(
  {
    // Frontend-visible fields
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', index: true },
    templateVersion: { type: Number },
    idempotencyKey: { type: String },
    captionProjectId: { type: Schema.Types.ObjectId, ref: 'CaptionProject', index: true },
    outputFormat: { type: String, default: 'mp4' },
    resolution: { type: String, default: '1080p' },
    scale: { type: Number, default: 1, min: 0.1, max: 1 },
    fps: { type: Number, default: 30 },
    renderId: { type: String },
    lastProgressAt: { type: Date },
    shareToken: { type: String, select: false, default: () => newShareToken() },
    outputBucket: { type: String, select: false },
    outputKey: { type: String, select: false },
    outputUrl: { type: String },
    thumbnailUrl: { type: String },
    status: {
      type: String,
      enum: ['pending', 'queued', 'rendering', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    renderType: {type: String, enum: ['Template', 'CaptionProject'], default: 'Template'},
    progress: { type: Number, default: 0 },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    
    // Hidden from frontend (select: false)
    inputProps: { type: Schema.Types.Mixed, required: true, select: false },
    bucketName: { type: String, select: false },
    serveUrl: { type: String, select: false },
    webhookUrl: { type: String, select: false },
    webhookSent: { type: Boolean, default: false, select: false },
    variables: { type: Schema.Types.Mixed, select: false },
    
    // Cost fields - hidden
    estimatedCost: { type: Number, select: false },
    actualCost: { type: Number, select: false },
    costDisplay: { type: String, select: false },
    currency: { type: String, select: false },
    
    // Render metrics - hidden
    framesRendered: { type: Number, select: false },
    chunks: { type: Number, select: false },
    timeToRenderFrames: { type: Number, select: false },
    timeToFinish: { type: Number, select: false },
    timeToFinishChunks: { type: Number, select: false },
    timeToEncode: { type: Number, select: false },
    timeToCombine: { type: Number, select: false },
    combinedFrames: { type: Number, select: false },
    lambdasInvoked: { type: Number, select: false },
    outputSizeInBytes: { type: Number, select: false },
    estimatedBillingDurationInMilliseconds: { type: Number, select: false },
    
    // Status flags - hidden
    fatalErrorEncountered: { type: Boolean, select: false },
    compositionValidated: { type: Number, select: false }, // Changed from Boolean to Number
    functionLaunched: { type: Number, select: false }, // Changed from Boolean to Number
    serveUrlOpened: { type: Number, select: false }, // Changed from Boolean to Number
    timeoutTimestamp: { type: Number, select: false },
    
    // Additional data - hidden
    renderSize: { type: Number, select: false },
    currentTime: { type: Number, select: false },
    type: { type: String, select: false },
    outKey: { type: String, select: false },
    outBucket: { type: String, select: false },
    artifacts: { type: [Schema.Types.Mixed], select: false },
    renderMetadata: { type: Schema.Types.Mixed, select: false },
    encodingStatus: {
      type: {
        framesEncoded: { type: Number },
        combinedFrames: { type: Number },
        timeToCombine: { type: Number },
      },
      select: false,
    },
    cleanup: { type: Schema.Types.Mixed, select: false },
    mostExpensiveFrameRanges: { type: [Schema.Types.Mixed], select: false },
    renderErrors: { type: [Schema.Types.Mixed], select: false },
  },
  { timestamps: true }
);

// Indexes
RenderJobSchema.index({ templateId: 1, createdAt: -1 });
RenderJobSchema.index({ captionProjectId: 1, createdAt: -1 });

// Static method to get all fields (for internal/admin use)
RenderJobSchema.statics.findByIdWithAllFields = function(id: string) {
  return this.findById(id).select('+inputProps +bucketName +serveUrl +webhookUrl +webhookSent +estimatedCost +actualCost +costDisplay +currency +framesRendered +chunks +timeToRenderFrames +timeToFinish +timeToFinishChunks +timeToEncode +timeToCombine +combinedFrames +lambdasInvoked +outputSizeInBytes +estimatedBillingDurationInMilliseconds +fatalErrorEncountered +compositionValidated +functionLaunched +serveUrlOpened +timeoutTimestamp +renderSize +currentTime +type +outKey +outBucket +artifacts +renderMetadata +encodingStatus +cleanup +mostExpensiveFrameRanges +renderErrors');
};

// One job per (user, idempotency key).
RenderJobSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

// Lists sort by newest first, per user and optionally by status.
RenderJobSchema.index({ userId: 1, createdAt: -1 });
RenderJobSchema.index({ userId: 1, status: 1, createdAt: -1 });
// Template renders list and the maintenance sweep.
RenderJobSchema.index({ templateId: 1, userId: 1, createdAt: -1 });
RenderJobSchema.index({ status: 1, updatedAt: 1 });

export const RenderJob = mongoose.model<IRenderJob>('RenderJob', RenderJobSchema);