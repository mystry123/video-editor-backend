// models/DirectorRun.ts
//
// One Cue Director run: a creative edit made for a request ("turn this into
// a punchy 15 second reel"). The run watches the footage, writes a brief,
// has specialists make their parts, checks and reviews the draft, and ends
// with a draft project the editor shows for review. Progress is stored as it
// goes so the editor can show each stage; the editor polls it.

import mongoose, { Schema, Document, Types } from 'mongoose';

export type DirectorStage = 'queued' | 'watching' | 'briefing' | 'cutting' | 'crafting' | 'assembling' | 'reviewing' | 'revising' | 'done' | 'failed' | 'stopped';

export interface DirectorEvent {
  at: Date;
  stage: DirectorStage;
  text: string;
}

/** What the user did with the draft: the signal the Director learns from */
export interface DirectorOutcome {
  applied?: Date;
  discarded?: Date;
  /** Parts unticked when applying (titles, sound…) */
  leftOut?: string[];
  /** The edit was undone or removed soon after it was applied */
  undone?: Date;
  /** Thumbs up (1) or down (-1) */
  rating?: number;
  comment?: string;
  /** The project was rendered after the edit was applied */
  exported?: Date;
}

export interface IDirectorRun extends Document {
  userId: Types.ObjectId;
  projectId: string;
  request: string;
  stage: DirectorStage;
  events: DirectorEvent[];
  /** The director's creative brief */
  brief?: unknown;
  /** Each specialist's decisions, latest round */
  parts?: unknown;
  /** Review rounds: score and notes */
  reviews?: unknown[];
  /** The edited project for the editor (project + elements), with groups the user can leave out */
  result?: unknown;
  error?: string;
  stopRequested: boolean;
  usageJobId: string;
  outcome?: DirectorOutcome;
  createdAt: Date;
  updatedAt: Date;
}

const DirectorRunSchema = new Schema<IDirectorRun>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: String, required: true, maxlength: 100 },
    request: { type: String, required: true, maxlength: 4000 },
    stage: { type: String, required: true, default: 'queued' },
    events: [{ _id: false, at: Date, stage: String, text: { type: String, maxlength: 500 } }],
    brief: { type: Schema.Types.Mixed },
    parts: { type: Schema.Types.Mixed },
    reviews: [{ type: Schema.Types.Mixed }],
    result: { type: Schema.Types.Mixed },
    error: { type: String, maxlength: 1000 },
    stopRequested: { type: Boolean, default: false },
    usageJobId: { type: String, required: true },
    outcome: {
      applied: Date,
      discarded: Date,
      leftOut: [{ type: String, maxlength: 20 }],
      undone: Date,
      rating: Number,
      comment: { type: String, maxlength: 1000 },
      exported: Date,
    },
  },
  { timestamps: true }
);

DirectorRunSchema.index({ userId: 1, projectId: 1, createdAt: -1 });

export const DirectorRun = mongoose.model<IDirectorRun>('DirectorRun', DirectorRunSchema);
