// models/MediaAnalysis.ts
//
// What is in one uploaded video or audio file, as Gemini watched it: a
// summary, the shots, what is said (with times) and the moments worth using.
// Cue's Director reads it to make editing decisions about the footage itself
// instead of guessing from file names. One per file and analysis version;
// made on demand and kept, since the file never changes.

import mongoose, { Schema, Document, Types } from 'mongoose';

/** Bump when the prompt or shape changes: older analyses are made again */
export const MEDIA_ANALYSIS_VERSION = 3;

export interface AnalysisShot {
  start: number;
  end: number;
  description: string;
  framing?: string;
  people?: number;
  onScreenText?: string;
  motion?: string;
  /** How the shot begins in the source: a cut, or a dissolve/fade already in the footage */
  enters?: string;
}

export interface AnalysisLine {
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

export interface AnalysisMoment {
  start: number;
  end: number;
  title: string;
  why: string;
  kind: string;
  score: number;
}

export interface MediaAnalysisResult {
  summary: string;
  kind: string;
  language?: string;
  hasSpeech: boolean;
  hasMusic: boolean;
  /** Subtitles/captions of the speech are already burned into the picture */
  hasBurnedCaptions?: boolean;
  shots: AnalysisShot[];
  speech: AnalysisLine[];
  moments: AnalysisMoment[];
}

export interface IMediaAnalysis extends Document {
  fileId: Types.ObjectId;
  userId: Types.ObjectId;
  version: number;
  status: 'ready' | 'failed';
  /** Seconds of the file that were analysed (very long files: the start) */
  analysedSeconds: number;
  duration: number;
  modelName: string;
  /** Where the speech came from: the file's transcript, or Gemini listening */
  speechSource: 'transcript' | 'model' | 'none';
  result?: MediaAnalysisResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MediaAnalysisSchema = new Schema<IMediaAnalysis>(
  {
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['ready', 'failed'], required: true },
    analysedSeconds: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    modelName: { type: String, default: "" },
    speechSource: { type: String, enum: ['transcript', 'model', 'none'], default: 'none' },
    result: { type: Schema.Types.Mixed },
    error: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);

MediaAnalysisSchema.index({ fileId: 1, version: 1 }, { unique: true });

export const MediaAnalysis = mongoose.model<IMediaAnalysis>('MediaAnalysis', MediaAnalysisSchema);
