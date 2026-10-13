// models/ChatSession.ts
//
// A conversation with Cue, the editing assistant, in one project. The editor
// saves the whole visible thread after each turn (text, plus a short note of
// what each reply proposed and whether it was applied), so history follows
// the user across devices. Edits themselves live in the project, not here.

import mongoose, { Schema, Document, Types } from 'mongoose';

export const MAX_SESSION_MESSAGES = 200;
/** Oldest chats beyond this (per user and project) are removed */
export const MAX_SESSIONS_PER_PROJECT = 50;

export interface IChatMessage {
  role: 'user' | 'model';
  text: string;
  note?: string;
  at: Date;
}

export interface IChatSession extends Document {
  userId: Types.ObjectId;
  projectId: string;
  title: string;
  messages: IChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    role: { type: String, enum: ['user', 'model'], required: true },
    text: { type: String, default: '', maxlength: 8000 },
    note: { type: String, maxlength: 2000 },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const ChatSessionSchema = new Schema<IChatSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: String, required: true, maxlength: 64 },
    title: { type: String, required: true, maxlength: 80 },
    messages: { type: [ChatMessageSchema], default: [] },
  },
  { timestamps: true }
);

ChatSessionSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });

export const ChatSession = mongoose.model<IChatSession>('ChatSession', ChatSessionSchema, 'chat_sessions');
