import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { RenderJob } from '../src/models/RenderJob';
import { User } from '../src/models/User';
import { reframeQueue } from '../src/queues';
import { Transcription } from '../src/models/Transcription';
import { planAnalysis } from '../src/services/reframeEngine.service';

const plan = { engine: '2.0.0-dev', target: '1:1', source: { fps: 25, duration: 40, width: 360, height: 640 }, segments: [{ start: 0, end: 40, layout: 'single', zones: [] }], overlays: [] };

vi.mock('../src/services/reframeEngine.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/reframeEngine.service')>();
  return {
    ...actual,
    reframeEngineConfigured: () => true,
    planAnalysis: vi.fn(async () => plan),
    getAnalysis: vi.fn(async () => ({ id: 'a1', status: 'done', text: [{ id: 'bottom-captions', canKeep: true }] })),
  };
});

async function video(userId: unknown, extra: Record<string, unknown> = {}) {
  return File.create({ userId, name: 'v', originalName: 'v.mp4', mimeType: 'video/mp4', size: 1, storageKey: 'k',
    cdnUrl: 'https://cdn.test/k.mp4', status: 'ready', metadata: { duration: 40, width: 360, height: 640 }, ...extra });
}

describe('AI reframe with the engine service', () => {
  it('queues an analysis with the plan quality and the user choices', async () => {
    const { user, auth } = await createUser();
    await User.updateOne({ _id: user._id }, { $push: { planOverrides: { field: 'reframeQuality', value: 'high' } } });
    const f = await video(user._id);
    const res = await api().post('/api/v1/reframe').set(auth)
      .send({ fileId: String(f._id), aspectRatio: '2:3', elementId: 'e', zoom: 'tight', keepText: ['bottom-captions'] });
    expect(res.status).toBe(201);
    const [, data] = vi.mocked(reframeQueue.add).mock.calls[0] as any[];
    expect(data).toMatchObject({ engine: 'v2', quality: 'high', zoom: 'tight', keepText: ['bottom-captions'], aspectRatio: '2:3' });
    const status = await api().get(`/api/v1/reframe/status/${f._id}/2:3`).set(auth);
    expect(status.body).toMatchObject({ status: 'queued', engine: 'v2' });
  });

  it('plans a new shape from the existing analysis without queueing', async () => {
    const { user, auth } = await createUser();
    const f = await video(user._id, { reframeAnalysis: { id: 'a1', quality: 'standard', transcriptAt: null } });
    const res = await api().post('/api/v1/reframe').set(auth).send({ fileId: String(f._id), aspectRatio: '1:1', elementId: 'e' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'already_done', engine: 'v2', result: { target: '1:1' } });
    expect(res.body.text[0].id).toBe('bottom-captions');
    expect(reframeQueue.add).not.toHaveBeenCalled();
  });

  it('renders a v2 reframe with its segments', async () => {
    const { user, auth } = await createUser();
    const f = await video(user._id, { reframe: { '1_1': { status: 'completed', engine: 'v2', result: plan } } });
    const res = await api().post('/api/v1/render/reframe').set(auth).send({ fileId: String(f._id), aspectRatio: '1:1' });
    expect(res.status).toBe(202);
    const job = await RenderJob.findById(res.body.id).select('+inputProps');
    const el = job!.inputProps.elements[0];
    expect(el.reframeData).toMatchObject({ engine: 'v2', result: { segments: plan.segments } });
    expect(job!.inputProps.project).toMatchObject({ width: 1080, height: 1080, fps: 25, duration: 40 });
    expect(job!.inputProps.elements).toHaveLength(1);                 // no captions unless replaced
  });

  it('passes the captions choice to the engine and remembers it', async () => {
    const { user, auth } = await createUser();
    const f = await video(user._id, { reframeAnalysis: { id: 'a1', quality: 'standard', transcriptAt: null } });
    const res = await api().post('/api/v1/reframe').set(auth)
      .send({ fileId: String(f._id), aspectRatio: '16:9', elementId: 'e', captions: 'replace' });
    expect(res.status).toBe(200);
    expect(vi.mocked(planAnalysis).mock.calls.at(-1)![1]).toMatchObject({ ratio: '16:9', captions: 'replace' });
    expect(res.body.options).toMatchObject({ captions: 'replace' });
    const bad = await api().post('/api/v1/reframe').set(auth)
      .send({ fileId: String(f._id), aspectRatio: '1:1', elementId: 'e', captions: 'erase' });
    expect(vi.mocked(planAnalysis).mock.calls.at(-1)![1]).toMatchObject({ captions: 'keep' });   // unknown → keep
    expect(bad.status).toBe(200);
  });

  it('adds Shotline captions for the times the old ones were replaced', async () => {
    const { user, auth } = await createUser();
    const replaced = { ...plan, target: '16:9', captions: { mode: 'replace', replaced: [[0, 2], [10, 12]], kept: [[2, 10]] } };
    const f = await video(user._id, { reframe: { '16_9': { status: 'completed', engine: 'v2', result: replaced } } });
    await Transcription.create({ userId: user._id, fileId: f._id, status: 'completed', words: [
      { text: 'Hello', start: 0.2, end: 0.6, type: 'word' }, { text: 'there', start: 5, end: 5.4, type: 'word' },
      { text: 'bye', start: 10.5, end: 10.9, type: 'word' },
    ] });
    const res = await api().post('/api/v1/render/reframe').set(auth).send({ fileId: String(f._id), aspectRatio: '16:9' });
    expect(res.status).toBe(202);
    const job = await RenderJob.findById(res.body.id).select('+inputProps');
    const captions = job!.inputProps.elements.filter((e: any) => e.type === 'caption');
    expect(captions.map((c: any) => [c.time, c.transcription.words.map((w: any) => w.word)])).toEqual([[0, ['Hello']], [10, ['bye']]]);
    // The editor previews the same captions.
    const status = await api().get(`/api/v1/reframe/status/${f._id}/16:9`).set(auth);
    expect(status.body.captionElements).toEqual(JSON.parse(JSON.stringify(captions)));
  });
});
