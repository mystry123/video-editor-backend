// models/DirectorLessonSet.ts
//
// What Cue Director has learned from past edits: short rules per crew member
// (director, story, type, motion, sound, assets), written from the
// director's reviews and what users did with drafts. A new set is a
// candidate until the eval gate shows it does better than the live one;
// then it goes live and the old one retires. Problems that are code bugs,
// not craft, are listed for people to fix and never become rules.

import mongoose, { Schema, Document } from 'mongoose';

export const LESSON_CREW = ['director', 'story', 'type', 'motion', 'sound', 'assets'] as const;
export type LessonCrew = (typeof LESSON_CREW)[number];

export interface IDirectorLessonSet extends Document {
  status: 'candidate' | 'live' | 'rejected' | 'retired';
  lessons: Partial<Record<LessonCrew, string[]>>;
  /** Problems for people to fix (rendering, layout…), with how often they came up */
  bugs: Array<{ problem: string; evidence: number }>;
  /** Runs it was written from */
  basedOnRuns: number;
  /** Eval gate: mean judge score with the live set and with this one */
  gate?: { live: number; candidate: number; cases: number; at: Date };
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DirectorLessonSetSchema = new Schema<IDirectorLessonSet>(
  {
    status: { type: String, enum: ['candidate', 'live', 'rejected', 'retired'], required: true, index: true },
    lessons: { type: Schema.Types.Mixed, default: {} },
    bugs: [{ _id: false, problem: { type: String, maxlength: 500 }, evidence: Number }],
    basedOnRuns: { type: Number, default: 0 },
    gate: { live: Number, candidate: Number, cases: Number, at: Date },
    note: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
);

export const DirectorLessonSet = mongoose.model<IDirectorLessonSet>('DirectorLessonSet', DirectorLessonSetSchema);
