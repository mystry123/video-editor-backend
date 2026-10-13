// controllers/chatSession.controller.ts — Cue's saved conversations, per project.
//
//   GET    /ai/sessions?projectId=   the user's chats in a project, newest first (no messages)
//   POST   /ai/sessions              { projectId, title?, messages? } → a new chat
//   GET    /ai/sessions/:id          one chat with its messages
//   PUT    /ai/sessions/:id          { title?, messages? } (the editor sends the whole thread)
//   DELETE /ai/sessions/:id
//
// Only the owner's chats are ever found. A project keeps its 50 latest chats.

import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { ChatSession, MAX_SESSIONS_PER_PROJECT, type IChatMessage } from '../models/ChatSession';
import { ApiError } from '../utils/ApiError';

type IncomingMessage = { role: 'user' | 'model'; text: string; note?: string; at?: string };

/** "  make the title   yellow and…" → "Make the title yellow and…" */
export function titleFrom(messages: IncomingMessage[] | undefined): string {
  const first = messages?.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (!first) return 'New chat';
  const t = first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const toMessages = (list: IncomingMessage[]): IChatMessage[] =>
  list.map((m) => ({ role: m.role, text: m.text, ...(m.note ? { note: m.note } : {}), at: m.at ? new Date(m.at) : new Date() }));

const summary = (s: any) => ({
  id: String(s._id),
  projectId: s.projectId,
  title: s.title,
  messageCount: s.messages?.length ?? s.messageCount ?? 0,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const full = (s: any) => ({ ...summary(s), messages: (s.messages ?? []).map((m: any) => ({ role: m.role, text: m.text, note: m.note, at: m.at })) });

async function owned(req: AuthRequest) {
  const session = await ChatSession.findOne({ _id: req.params.id, userId: req.userId });
  if (!session) throw ApiError.notFound('Chat not found');
  return session;
}

export const listSessions = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessions = await ChatSession.aggregate([
      { $match: { userId: new Types.ObjectId(req.userId), projectId: String(req.query.projectId) } },
      { $sort: { updatedAt: -1 } },
      { $limit: MAX_SESSIONS_PER_PROJECT },
      { $project: { projectId: 1, title: 1, createdAt: 1, updatedAt: 1, messageCount: { $size: '$messages' } } },
    ]);
    res.json({ sessions: sessions.map(summary) });
  } catch (error) {
    next(error);
  }
};

export const createSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { projectId, title, messages = [] } = req.body as { projectId: string; title?: string; messages?: IncomingMessage[] };
    const session = await ChatSession.create({ userId: req.userId, projectId, title: title?.trim() || titleFrom(messages), messages: toMessages(messages) });
    // Keep the newest chats in this project
    const old = await ChatSession.find({ userId: req.userId, projectId }).sort({ updatedAt: -1 }).skip(MAX_SESSIONS_PER_PROJECT).select('_id').lean();
    if (old.length) await ChatSession.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    res.status(201).json({ session: full(session) });
  } catch (error) {
    next(error);
  }
};

export const getSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ session: full(await owned(req)) });
  } catch (error) {
    next(error);
  }
};

export const updateSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, messages } = req.body as { title?: string; messages?: IncomingMessage[] };
    const session = await owned(req);
    if (messages) {
      session.messages = toMessages(messages);
      // Still the automatic title: follow the first message
      if (!title && session.title === 'New chat') session.title = titleFrom(messages);
    }
    if (title?.trim()) session.title = title.trim();
    await session.save();
    res.json({ session: summary(session) });
  } catch (error) {
    next(error);
  }
};

export const deleteSession = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await ChatSession.deleteOne({ _id: req.params.id, userId: req.userId });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};
