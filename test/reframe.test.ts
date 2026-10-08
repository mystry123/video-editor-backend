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
