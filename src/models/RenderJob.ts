import mongoose, { Schema, Document, Types } from 'mongoose';
import { RenderStatus } from '../types';

export interface IRenderJob extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  templateId?: Types.ObjectId;
  inputProps: any;
  outputFormat: string;
  resolution: string;
  fps: number;
  renderId?: string;
  bucketName?: string;
  serveUrl?: string;
  outputUrl?: string;
  outputSize?: number;
  status: RenderStatus;
  progress: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  webhookUrl?: string;
  webhookSent: boolean;
  estimatedCost?: number;
  actualCost?: number;
  costDisplay?: string;
  currency?: string;
  framesRendered?: number;
  chunks?: number;
  timeToRenderFrames?: number;
  timeToFinish?: number;
  timeToFinishChunks?: number;
  timeToEncode?: number;
  outputSizeInBytes?: number;
  estimatedBillingDurationInMilliseconds?: number;
  timeToCombine?: number;
  combinedFrames?: number;
  lambdasInvoked?: number;
  fatalErrorEncountered?: boolean;
  renderSize?: number;
  currentTime?: number;
  type?: string;
  encodingStatus?: {
    framesEncoded: number;
    combinedFrames: number;
    timeToCombine: number | null;
  };
  cleanup?: {
    doneIn: number;
    filesDeleted: number;
    minFilesToDelete: number;
  };
  mostExpensiveFrameRanges?: Array<{
    timeInMilliseconds: number;
    chunk: number;
    frameRange: [number, number];
  }>;
  outKey?: string;
  outBucket?: string;
  timeoutTimestamp?: number;
  compositionValidated?: number;
  functionLaunched?: number;
  serveUrlOpened?: number;
  artifacts?: any[];
  renderErrors?: any[];
  renderMetadata?: any;
  createdAt: Date;
  updatedAt: Date;
}

const RenderJobSchema = new Schema<IRenderJob>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', index: true },
    inputProps: { type: Schema.Types.Mixed, required: true },
    outputFormat: { type: String, default: 'mp4' },
    resolution: { type: String, default: '1080p' },
    fps: { type: Number, default: 30 },
    renderId: { type: String },
    bucketName: { type: String },
    serveUrl: { type: String },
    outputUrl: { type: String },
    outputSize: { type: Number },
    status: {
      type: String,
      enum: ['pending', 'queued', 'rendering', 'encoding', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    progress: { type: Number, default: 0 },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    webhookUrl: { type: String },
    webhookSent: { type: Boolean, default: false },
    estimatedCost: { type: Number },
    actualCost: { type: Number },
    costDisplay: { type: String },
    currency: { type: String },
    framesRendered: { type: Number },
    chunks: { type: Number },
    timeToRenderFrames: { type: Number },
    timeToFinish: { type: Number },
    timeToFinishChunks: { type: Number },
    timeToEncode: { type: Number },
    outputSizeInBytes: { type: Number },
    estimatedBillingDurationInMilliseconds: { type: Number },
    timeToCombine: { type: Number },
    combinedFrames: { type: Number },
    lambdasInvoked: { type: Number },
    fatalErrorEncountered: { type: Boolean },
    renderSize: { type: Number },
    currentTime: { type: Number },
    type: { type: String },
    encodingStatus: {
      framesEncoded: { type: Number },
      combinedFrames: { type: Number },
      timeToCombine: { type: Number },
    },
    cleanup: {
      doneIn: { type: Number },
      filesDeleted: { type: Number },
      minFilesToDelete: { type: Number },
    },
    mostExpensiveFrameRanges: [{
      timeInMilliseconds: { type: Number },
      chunk: { type: Number },
      frameRange: [{ type: Number }],
    }],
    outKey: { type: String },
    outBucket: { type: String },
    timeoutTimestamp: { type: Number },
    compositionValidated: { type: Number },
    functionLaunched: { type: Number },
    serveUrlOpened: { type: Number },
    artifacts: [{ type: Schema.Types.Mixed }],
    renderErrors: [{ type: Schema.Types.Mixed }],
    renderMetadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const RenderJob = mongoose.model<IRenderJob>('RenderJob', RenderJobSchema);
