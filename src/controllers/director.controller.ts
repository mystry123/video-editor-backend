// controllers/director.controller.ts
//
//   POST /ai/director            { projectId, request, messages?, context, project } → { run }
//   GET  /ai/director?projectId= → { run }   the latest run in a project (last 2 hours), or null
//   GET  /ai/director/:id        → { run }   (the editor polls this)
//   POST /ai/director/:id/stop   → { run }
//
// Cue Director: a creative edit made by a crew of models (see
// services/director/run.ts). Starting one reserves a `directorRuns` unit;
// the result is a draft project the editor shows for review.

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { DirectorRun, type IDirectorRun } from '../models/DirectorRun';
import { startDirectorRun, stopDirectorRun, type DirectorInput } from '../services/director/run';

/** What the editor sees of a run */
export function runView(run: IDirectorRun) {
  return {
    id: String(run._id),
    projectId: run.projectId,
    request: run.request,
    stage: run.stage,
    events: run.events.map((e) => ({ at: e.at, stage: e.stage, text: e.text })),
    brief: run.brief ?? null,
    result: run.stage === 'done' ? (run.result ?? null) : null,
    error: run.error ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export const startDirector = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as Omit<DirectorInput, 'conversation'> & { messages?: DirectorInput['conversation'] };
    // One run at a time per project
    const busy = await DirectorRun.exists({ userId: req.userId, projectId: body.projectId, stage: { $nin: ['done', 'failed', 'stopped'] }, updatedAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) } });
    if (busy) throw ApiError.withCode(409, 'DIRECTOR_BUSY', 'Cue Director is already working on this project. Wait for it, or stop it first.');
    const run = await startDirectorRun(String(req.userId), {
      projectId: body.projectId,
      request: body.request,
      conversation: body.messages ?? [],
      context: body.context,
      project: body.project,
    });
    res.status(202).json({ run: runView(run) });
  } catch (error) {
    next(error);
  }
};

export const latestDirector = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const run = await DirectorRun.findOne({ userId: req.userId, projectId: String(req.query.projectId), createdAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }).sort({ createdAt: -1 });
    res.json({ run: run ? runView(run) : null });
  } catch (error) {
    next(error);
  }
};

export const getDirector = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const run = await DirectorRun.findOne({ _id: req.params.id, userId: req.userId });
    if (!run) throw ApiError.notFound('Run not found');
    res.json({ run: runView(run) });
  } catch (error) {
    next(error);
  }
};

export const stopDirector = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await stopDirectorRun(String(req.params.id), String(req.userId));
    const run = await DirectorRun.findOne({ _id: req.params.id, userId: req.userId });
    if (!run) throw ApiError.notFound('Run not found');
    res.json({ run: runView(run) });
  } catch (error) {
    next(error);
  }
};
