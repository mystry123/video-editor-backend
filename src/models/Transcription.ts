import mongoose, { Schema, Document, Types } from 'mongoose';
import { TranscriptionStatus } from '../types';

export interface ITranscriptionWord {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing' | 'punctuation';
  speaker_id?: string;
}

export interface ITranscriptionSpeaker {
  speaker_id: string;
  start: number;
  end: number;
  text: string;
}

export interface ITranscription extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fileId: Types.ObjectId;
  elevenLabsId?: string;
  text?: string;
  words?: ITranscriptionWord[];
  speakers?: ITranscriptionSpeaker[];
  language?: string;
  transcriptionModel: string;
  status: TranscriptionStatus;
  error?: string;
  duration?: number;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  __v?: number;
}

const TranscriptionSchema = new Schema<ITranscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true, unique: true },
    elevenLabsId: { type: String },
    text: { type: String },
    words: [
      {
        text: { type: String },
        start: { type: Number },
        end: { type: Number },
        type: { type: String, enum: ['word', 'spacing', 'punctuation'] },
        speaker_id: { type: String },
      },
    ],
    speakers: [
      {
        speaker_id: { type: String },
        start: { type: Number },
        end: { type: Number },
        text: { type: String },
      },
    ],
    language: { type: String },
    transcriptionModel: { type: String, default: 'scribe_v1' },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    error: { type: String },
    duration: { type: Number },
    processedAt: { type: Date },
  },
  { timestamps: true }
);

export const Transcription = mongoose.model<ITranscription>('Transcription', TranscriptionSchema);
