import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { reframeQueue } from '../src/queues';
import { detectSourceRatio, fallbackLayout, isValidLayout, sampleEveryFor } from '../src/services/reframe.service';

describe('reframe inputs', () => {
  it('classifies 4:5 sources correctly (they used to come out as 9:16)', () => {
    expect(detectSourceRatio(1080, 1350)).toBe('4:5');
    expect(detectSourceRatio(1080, 1920)).toBe('9:16');
    expect(detectSourceRatio(1080, 1080)).toBe('1:1');
    expect(detectSourceRatio(1920, 1080)).toBe('16:9');
  });

  it('scales sampling with video length', () => {
    expect(sampleEveryFor(10)).toBe(3);
    expect(sampleEveryFor(120)).toBe(12);
    expect(sampleEveryFor(3600)).toBe(30);
    expect(sampleEveryFor(undefined)).toBe(3);
  });

  it('rejects broken layouts and falls back to the most visible person', () => {
    expect(isValidLayout(null)).toBe(false);
    expect(isValidLayout({ layout_type: 'x', reasoning: '', confidence: 1, zones: [{ zone_id: 'a', person_ids: [1], crop_cx: 2, crop_cy: 0.5, crop_width: 0.5, crop_height: 0.5, canvas_top: 0, canvas_left: 0, canvas_w: 1, canvas_h: 1 }] })).toBe(false);
    const det = (person_id: number) => ({ time: 0, frame: 0, confidence: 1, person_id, bbox: { x1: 0, y1: 0, x2: 1, y2: 1, cx: 0.5, cy: 0.5, width: 1, height: 1 } });
    const layout = fallbackLayout([det(3), det(7), det(7)]);
    expect(isValidLayout(layout)).toBe(true);
    expect(layout.zones[0].person_ids).toEqual([7]);
    expect(fallbackLayout([]).zones[0].person_ids).toEqual([]);
  });
});

describe('POST /reframe', () => {
  it('refuses videos longer than the plan allows, before queueing', async () => {
    const { user, auth } = await createUser();
    const file = await File.create({
      userId: user._id, name: 'v', originalName: 'v.mp4', mimeType: 'video/mp4', size: 1,
      storageKey: 'k', cdnUrl: 'https://cdn.test/k', status: 'ready', metadata: { duration: 600, width: 1920, height: 1080 },
    });
    const res = await api().post('/api/v1/reframe').set(auth).send({ fileId: String(file._id), aspectRatio: '9:16', elementId: 'e' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REFRAME_TOO_LONG');
    expect(reframeQueue.add).not.toHaveBeenCalled();
  });
});

describe('GET /reframe', () => {
  it("lists the user's reframes, one per video and shape, newest first, and nobody else's", async () => {
    const { user, auth } = await createUser();
    const other = await createUser();
    const base = { name: 'v', mimeType: 'video/mp4', size: 1, cdnUrl: 'https://cdn.test/k', status: 'ready' };
    await File.create({
      ...base, storageKey: 'list-1', userId: user._id, originalName: 'talk.mp4',
      reframe: {
        '9_16': { status: 'completed', engine: 'v2', processedAt: new Date('2026-10-01') },
        '1_1': { status: 'pending', engine: 'v2', processedAt: new Date('2026-10-05') },
      },
    });
    await File.create({ ...base, storageKey: 'list-2', userId: user._id, originalName: 'plain.mp4' });
    await File.create({ ...base, storageKey: 'list-3', userId: other.user._id, originalName: 'theirs.mp4', reframe: { '9_16': { status: 'completed' } } });

    const res = await api().get('/api/v1/reframe').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: any) => [i.fileName, i.aspectRatio, i.status])).toEqual([
      ['talk.mp4', '1:1', 'queued'],
      ['talk.mp4', '9:16', 'completed'],
    ]);
  });

  it('needs a signed-in user', async () => {
    expect((await api().get('/api/v1/reframe')).status).toBe(401);
  });
});
