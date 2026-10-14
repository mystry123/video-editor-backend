import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from './helpers';
import { DirectorRun } from '../src/models/DirectorRun';
import { DirectorLessonSet } from '../src/models/DirectorLessonSet';
import { File } from '../src/models/File';
import { UsageEntry } from '../src/models/Usage';
import { setGeminiClient, type GeminiRequest, type GeminiResult } from '../src/services/ai/gemini';
import { forgetLessons, lessonBlock, liveLessons } from '../src/services/director/lessons';
import { env } from '../src/config/env';

// The eval gate edits with whatever lessons it is given; this judge prefers edits made with "Snap cuts" in the story rules
const edits: Array<{ key: string; lessons: any }> = [];
vi.mock('../src/services/director/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/director/run')>();
  return {
    ...real,
    directEdit: vi.fn(async (ctx: any) => {
      edits.push({ key: ctx.key, lessons: ctx.lessons });
      return { result: { project: {}, elements: [], groups: {}, notes: [], storyboard: [], liked: JSON.stringify(ctx.lessons).includes('Snap cuts') }, brief: {} };
    }),
  };
});
vi.mock('../src/services/director/review', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/director/review')>();
  return { ...real, judgeEdit: vi.fn(async (result: any) => ({ overall: result.liked ? 7 : 5 })) };
});

const { distillLessons, gateCandidate, runDigest, MIN_NEW_RUNS } = await import('../src/services/director/learning');

const requests: GeminiRequest[] = [];
let distilled: unknown = {};
const fake = {
  generate: vi.fn(async (req: GeminiRequest): Promise<GeminiResult> => {
    requests.push(req);
    return { text: JSON.stringify(distilled), json: distilled, calls: [], usage: { input: 1, output: 1 }, model: req.model };
  }),
};

beforeEach(() => {
  requests.length = 0;
  edits.length = 0;
  forgetLessons();
  setGeminiClient(fake);
});
afterEach(() => setGeminiClient(null));

async function seedRuns(n: number, userId: unknown) {
  for (let i = 0; i < n; i++) {
    await DirectorRun.create({
      userId, projectId: `p${i}`, request: 'Punchy reel', stage: 'done', events: [], usageJobId: `u${i}-${Math.random()}`,
      brief: { platform: 'Reels', aspect: '9:16', targetSeconds: 15, tone: 'energetic' },
      reviews: [{ round: 1, score: 5, issues: [{ who: 'story', problem: 'Ends mid-sentence' }] }],
      outcome: i % 2 ? { applied: new Date(), leftOut: ['sound'] } : { discarded: new Date(), rating: -1, comment: 'too many whooshes' },
    });
  }
}

describe('learning from past edits', () => {
  it('says what happened to each run, plainly', () => {
    const text = runDigest({ request: 'reel', brief: { platform: 'Reels', aspect: '9:16', targetSeconds: 15, tone: 'fun' }, reviews: [{ round: 1, score: 5, issues: [{ who: 'type', problem: 'Title too small' }] }], outcome: { applied: true, leftOut: ['sound'], exported: true, rating: -1, comment: 'meh' } });
    expect(text).toContain('Review 1: 5/10');
    expect(text).toContain('[type] Title too small');
    expect(text).toContain('applied leaving out sound, then exported, thumbs down: "meh"');
  });

  it('waits for enough new runs, then writes a candidate rule set (rules capped, bugs kept apart)', async () => {
    const { user } = await createUser();
    await seedRuns(MIN_NEW_RUNS - 1, user._id);
    expect(await distillLessons()).toBeNull();
    await seedRuns(1, user._id);
    distilled = {
      lessons: { story: ['Snap cuts to sentence ends.', ...Array.from({ length: 12 }, (_, i) => `Rule ${i}`)], sound: ['At most 2 sound effects.'], nobody: ['x'] },
      bugs: [{ problem: 'Title text drawn outside its box', evidence: 3 }],
      note: 'Users drop sound effects',
    };
    const set = await distillLessons();
    expect(set?.status).toBe('candidate');
    expect(set?.lessons.story).toHaveLength(8);
    expect(set?.lessons.sound).toEqual(['At most 2 sound effects.']);
    expect((set?.lessons as any).nobody).toBeUndefined();
    expect(set?.bugs[0]).toMatchObject({ problem: 'Title text drawn outside its box', evidence: 3 });
    // The model saw the runs, the reviews and what users did
    expect(requests[0].messages[0].text).toContain('too many whooshes');
    expect(requests[0].system).toContain('never as rules');
    expect(requests[0].model).toBe(env.directorModel);
  });

  it('a candidate goes live only when the eval gate scores it better; the old set retires', async () => {
    const { user } = await createUser();
    const file = await File.create({ userId: user._id, name: 'v.mp4', originalName: 'v.mp4', mimeType: 'video/mp4', size: 1, storageKey: `users/${user._id}/uploads/v.mp4`, cdnUrl: 'https://cdn.test/v.mp4', status: 'ready', source: 'upload', metadata: { duration: 30 } });
    Object.assign(env, { directorEvalUser: String(user._id), directorEvalCases: JSON.stringify([{ fileId: String(file._id), request: 'reel' }, { fileId: String(file._id), request: 'short' }]) });
    try {
      const old = await DirectorLessonSet.create({ status: 'live', lessons: { story: ['Old rule'] }, bugs: [] });
      const worse = await gateCandidate(await DirectorLessonSet.create({ status: 'candidate', lessons: { story: ['Something else'] }, bugs: [] }));
      expect(worse.status).toBe('rejected');
      expect(worse.gate).toMatchObject({ live: 5, candidate: 5, cases: 2 });
      expect((await DirectorLessonSet.findById(old._id))?.status).toBe('live');

      const better = await gateCandidate(await DirectorLessonSet.create({ status: 'candidate', lessons: { story: ['Snap cuts to sentence ends.'] }, bugs: [] }));
      expect(better.status).toBe('live');
      expect(better.gate).toMatchObject({ live: 5, candidate: 7, cases: 2 });
      expect((await DirectorLessonSet.findById(old._id))?.status).toBe('retired');
      // Each case was edited with both sets
      expect(edits.filter((e) => e.key.startsWith(String(better._id))).map((e) => e.key.split('-').pop())).toEqual(['live', 'new', 'live', 'new']);
      expect(await liveLessons()).toEqual({ story: ['Snap cuts to sentence ends.'] });
    } finally {
      Object.assign(env, { directorEvalUser: '', directorEvalCases: '' });
    }
  });

  it('without eval cases a candidate is never promoted', async () => {
    const set = await gateCandidate(await DirectorLessonSet.create({ status: 'candidate', lessons: { story: ['x'] }, bugs: [] }));
    expect(set.status).toBe('rejected');
    expect(set.note).toMatch(/No eval cases/);
  });

  it('live rules reach the crew prompts', async () => {
    expect(lessonBlock(undefined)).toBe('');
    expect(lessonBlock(['Snap cuts.', 'Big titles.'])).toBe('\n\nLESSONS FROM PAST EDITS (follow them unless the brief or request says otherwise)\n- Snap cuts.\n- Big titles.');
  });
});

describe('Director runs a restart left behind', () => {
  it('fail and get their run back', async () => {
    const { runMaintenanceSweep } = await import('../src/services/maintenance.service');
    const { reserveUsage } = await import('../src/services/usage.service');
    const { user } = await createUser();
    await reserveUsage(user._id, 'directorRuns', 'director:stuck', 1, 3);
    const run = await DirectorRun.create({ userId: user._id, projectId: 'p', request: 'r', stage: 'cutting', events: [], usageJobId: 'director:stuck' });
    await DirectorRun.collection.updateOne({ _id: run._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await runMaintenanceSweep();
    expect((await DirectorRun.findById(run._id))?.stage).toBe('failed');
    expect((await UsageEntry.findOne({ jobId: 'director:stuck' }))?.state).toBe('released');
  });
});
