import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { MediaAnalysis, MEDIA_ANALYSIS_VERSION } from '../src/models/MediaAnalysis';
import { DirectorRun } from '../src/models/DirectorRun';
import { UsageCounter } from '../src/models/Usage';
import { currentPeriod } from '../src/services/usage.service';
import { setGeminiClient, type GeminiRequest, type GeminiResult } from '../src/services/ai/gemini';
import { setAudioTools } from '../src/services/audio';
import { compileEdit, fitTitle, wordsFromLines } from '../src/services/director/compile';
import { editProblems } from '../src/services/director/checks';
import { cutProblems, cutView, placeSegments, sourcesOf, type Source } from '../src/services/director/sources';
import type { Brief } from '../src/services/director/crew';
import { setStillRenderer, storyboardTimes } from '../src/services/director/review';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/storage.service')>();
  return { ...real, uploadBufferToS3: vi.fn(async (_b: Buffer, key: string) => `https://cdn.test/${key}`) };
});
// Captions in a run come from a real transcript of the speech
const transcribe = vi.fn(async () => ({ id: 't', text: 'Good morning from Lisbon.', audio_duration: 60, language_code: 'en', words: [{ text: 'Good', start: 3, end: 3.4, type: 'word' }, { text: ' ', start: 3.4, end: 3.45, type: 'spacing' }, { text: 'morning', start: 3.45, end: 4, type: 'word' }] }));
vi.mock('../src/services/transcription.service', () => ({ createElevenLabsTranscription: (...args: any[]) => (transcribe as any)(...args) }));
vi.mock('../src/utils/media', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/media')>();
  return { ...real, probeMedia: vi.fn(async () => ({ format: { duration: '1.0' }, streams: [{ codec_type: 'audio' }] })) };
});

const brief: Brief = {
  understood: 'A 10 second reel', platform: 'Instagram Reels', aspect: '9:16', targetSeconds: 10, tone: 'energetic', audience: 'travellers',
  hook: 'Open on the line at 0:03', structure: [{ beat: 'hook', seconds: 3, intent: 'line' }, { beat: 'payoff', seconds: 7, intent: 'view' }],
  story: 's', type: 't', captions: { use: true, style: 'word-pop', why: 'w' }, motion: 'm', sound: 's', assets: 'none', keepOtherLayers: false,
};

const analysis = {
  summary: 'A host in Lisbon.', kind: 'vlog', language: 'en', hasSpeech: true, hasMusic: false,
  shots: [{ start: 0, end: 30, description: 'Host talks' }, { start: 30, end: 60, description: 'View of the river' }],
  speech: [{ start: 3, end: 5, text: 'Good morning from Lisbon.' }, { start: 40, end: 46, text: 'Look at that.' }],
  moments: [{ start: 3, end: 5, title: 'Opener', why: 'Line', kind: 'hook', score: 8 }],
};

const source = (): Source => ({ ref: 'S1', fileId: 'f1', name: 'lisbon.mp4', kind: 'video', url: 'https://cdn.test/v.mp4', duration: 60, element: { id: 'v1' }, analysis });
const original = { project: { width: 1920, height: 1080, fps: 30, duration: 60, backgroundColor: '#000000' }, elements: [{ id: 'v1', type: 'video', fileId: 'f1', source: 'https://cdn.test/v.mp4', time: 0, duration: 60 }, { id: 't1', type: 'text', text: 'Old title', time: 0, duration: 3 }] };

describe('the cut', () => {
  it('places pieces back to back and says what is seen and said at each new time', () => {
    const segs = [{ source: 'S1', from: 3, to: 5.5 }, { source: 'S1', from: 39, to: 43 }];
    expect(placeSegments(segs).map((p) => [p.at, p.length])).toEqual([[0, 2.5], [2.5, 4]]);
    const view = cutView(segs, [source()]);
    expect(view).toContain('#1 0:00.0–0:02.5');
    expect(view).toContain('"Good morning from Lisbon."');
    expect(view).toContain('#2 0:02.5–0:06.5');
    expect(view).toContain('0:03.5 "Look at that."');
  });

  it('finds pieces outside their source, too short, unknown, and a wrong length', () => {
    const problems = cutProblems([{ source: 'S1', from: 58, to: 61 }, { source: 'S9', from: 0, to: 2 }, { source: 'S1', from: 3, to: 3.2 }], [source()], 15);
    expect(problems.join('\n')).toMatch(/outside S1/);
    expect(problems.join('\n')).toMatch(/no source S9/);
    expect(problems.join('\n')).toMatch(/too short/);
    expect(problems.join('\n')).toMatch(/asks for 15s/);
  });

  it('sources are the project\'s media files, once each', () => {
    const s = sourcesOf({ project: {}, elements: [...original.elements, { id: 'v2', type: 'video', fileId: 'f1', source: 'x', time: 70 }] });
    expect(s.map((x) => [x.ref, x.fileId])).toEqual([['S1', 'f1']]);
  });
});

describe('compiling an edit', () => {
  const edit = () =>
    compileEdit({
      original, brief, sources: [source()],
      segments: [{ source: 'S1', from: 3, to: 6 }, { source: 'S1', from: 39, to: 46 }],
      type: { titles: [{ text: 'LISBON', start: 0, end: 2, role: 'hook', position: 'upper', style: 'bold', motion: 'pop' }], captions: { use: true, style: 'word-pop', position: 'lower' }, notes: '' },
      motion: { pieces: [{ piece: 1, move: 'punch-in', transitionIn: 'cut' }, { piece: 2, move: 'slow-zoom-in', transitionIn: 'whip' }], notes: '' },
      sound: { originalAudio: 'keep', sfx: [{ at: 3, kind: 'whoosh' }], music: { use: true, mood: 'upbeat', prompt: 'p' }, notes: '' },
      sfx: [{ at: 2.9, asset: { url: 'https://cdn.test/w.mp3', fileId: 'w', duration: 1 } }],
      // A word-timed transcript (captions are only made from real word timings)
      words: { f1: wordsFromLines(analysis.speech) },
    });

  it('makes a valid 9:16 project: cut on track 1, overlays above, sounds on top', () => {
    const e = edit();
    expect(e.project).toMatchObject({ width: 1080, height: 1920, duration: 10 });
    const clips = e.elements.filter((x) => x.type === 'video');
    expect(clips.map((c) => [c.track, c.time, c.trimStart, c.trimDuration, c.fit])).toEqual([[1, 0, 3, 3.3, 'cover'], [1, 3, 39, 7, 'cover']]);
    // The whip overlaps the previous clip by its length (the previous clip plays on)
    expect(clips[1].transition).toMatchObject({ type: 'whip-pan', duration: 0.3 });
    expect(clips[0].keyframes.scale[0].value).toBe(118);
    expect(clips[1].keyframes.scale.map((k: any) => k.value)).toEqual([100, 112]);
    const tracks = e.elements.map((x) => [x.type, x.track]);
    expect(tracks).toEqual([['video', 1], ['video', 1], ['caption', 2], ['text', 3], ['audio', 4]]);
    expect(editProblems(e)).toEqual([]);
    expect(e.groups).toMatchObject({ cut: [clips[0].id, clips[1].id], motion: [clips[0].id, clips[1].id] });
    expect(e.notes.join(' ')).toMatch(/Music/);
    // The old title is left out (keepOtherLayers false)
    expect(e.elements.some((x) => x.text === 'Old title')).toBe(false);
  });

  it('captions carry the spoken words onto the new timeline', () => {
    const cap = edit().elements.find((x) => x.type === 'caption')!;
    const words = cap.transcription.words;
    expect(words[0]).toMatchObject({ word: 'Good', startMs: 0 });
    // "Look at that." said at 40 s in the source = 3 + (40 - 39) = 4 s
    expect(words.find((w: any) => w.word === 'Look').startMs).toBe(4000);
    expect(cap).toMatchObject({ displayMode: 'tiktok', y: '66%' });
  });

  it('never adds a second set of captions over footage that has them burned in', () => {
    const burned = { ...source(), analysis: { ...analysis, hasBurnedCaptions: true } };
    const e = compileEdit({ original, brief, sources: [burned], segments: [{ source: 'S1', from: 3, to: 6 }], type: { titles: [], captions: { use: true, style: 'word-pop', position: 'lower' }, notes: '' } });
    expect(e.elements.some((x) => x.type === 'caption')).toBe(false);
    expect(e.notes.join(' ')).toMatch(/already has them burned in/);
  });

  it('wide footage in a tall frame follows the subject; text-heavy shots are shown whole over a blur', () => {
    const wide = (shots: any[], extra: any = {}) => ({ ...source(), width: 1920, height: 1080, analysis: { ...analysis, shots, ...extra } });
    // Subject on the right third: the box (316% wide) slides left so x≈0.8 of the footage is centred
    const right = compileEdit({ original, brief, sources: [wide([{ start: 0, end: 60, description: 'Host', subjectX: 0.8 }])], segments: [{ source: 'S1', from: 3, to: 6 }] });
    const clip = right.elements.find((e) => e.type === 'video')!;
    expect(parseFloat(clip.width)).toBeCloseTo(316.05, 1);
    expect(clip.anchorX).toBeCloseTo(80, 0);
    expect(clip.fit).toBe('cover');
    // At the edge, the crop stops at the footage's edge (no black)
    const edge = compileEdit({ original, brief, sources: [wide([{ start: 0, end: 60, description: 'Host', subjectX: 1 }])], segments: [{ source: 'S1', from: 3, to: 6 }] }).elements.find((e) => e.type === 'video')!;
    const W = parseFloat(edge.width);
    const left = 50 - (edge.anchorX / 100) * W;
    expect(left).toBeCloseTo(100 - W, 1);
    // Words in the picture: whole picture (contain) over a blurred, muted copy on the track below
    const fit = compileEdit({ original, brief, sources: [wide([{ start: 0, end: 60, description: 'Title card', onScreenText: 'DAY 1' }])], segments: [{ source: 'S1', from: 3, to: 6 }] });
    const [back, front] = [...fit.elements].filter((e) => e.type === 'video').sort((a, b) => a.track - b.track);
    expect(front).toMatchObject({ fit: 'contain', muted: false, track: 2 });
    expect(back).toMatchObject({ fit: 'cover', muted: true, blurEnabled: true, track: 1, trimStart: 3, trimDuration: 3 });
    expect(fit.groups.backdrops).toEqual([back.id]);
    expect(editProblems(fit)).toEqual([]);
  });

  it('wide footage with burned-in captions fills the tall frame, zoomed past them (captions only if asked)', () => {
    const burned = { ...source(), width: 1920, height: 1080, analysis: { ...analysis, hasBurnedCaptions: true, shots: [{ start: 0, end: 60, description: 'Host', subjectX: 0.5 }] } };
    const e = compileEdit({ original, brief, sources: [burned], segments: [{ source: 'S1', from: 3, to: 6 }], type: { titles: [], captions: { use: false, style: 'word-pop', position: 'lower' }, notes: '' } });
    const clip = e.elements.find((x) => x.type === 'video')!;
    expect(clip).toMatchObject({ fit: 'cover', height: '120%', y: '0%', anchorY: 0 });
    expect(parseFloat(clip.width)).toBeCloseTo(316.05 * 1.2, 0);
    expect(e.groups.backdrops).toBeUndefined();
    // The typographer said no captions: none, though the old ones are out of frame
    expect(e.elements.some((x) => x.type === 'caption')).toBe(false);
  });

  it('footage only worth hearing: its clips are heard, not seen, and pictures cover the whole edit', () => {
    const e = compileEdit({
      original, brief: { ...brief, picture: 'replace' }, sources: [source()], segments: [{ source: 'S1', from: 3, to: 13 }],
      visuals: [
        { kind: 'image', url: 'https://cdn.test/a.png', fileId: 'a', start: 1, end: 3, placement: 'overlay' },
        { kind: 'video', url: 'https://cdn.test/b.mp4', fileId: 'b', duration: 2, start: 6, end: 8, placement: 'fullscreen' },
      ],
    });
    const clip = e.elements.find((x) => (e.groups.cut ?? []).includes(x.id))!;
    expect(clip).toMatchObject({ opacityEnabled: true, opacity: 0, muted: false });
    const pics = e.elements.filter((x) => (e.groups.extras ?? []).includes(x.id)).sort((a, b) => a.time - b.time);
    // Back to back from 0 to the end, all fullscreen; the short video loops
    expect(pics.map((p) => [p.time, p.time + (p.type === 'video' ? p.trimDuration : p.duration), p.width])).toEqual([[0, 6, '100%'], [6, 10, '100%']]);
    expect(pics[1].loop).toBe(true);
    expect(editProblems(e)).toEqual([]);
  });

  it('a title too wide for the frame breaks into two lines, then shrinks', () => {
    const frame = { width: 1080, height: 1920 };
    expect(fitTitle('LISBON', 8.5, frame, { upper: true, padEm: 0 })).toEqual({ text: 'LISBON', fontSize: 8.5 });
    const two = fitTitle('THE END OF CODING?', 8.5, frame, { upper: true, padEm: 0.3 });
    expect(two.text).toBe('THE END OF\nCODING?');
    expect(two.fontSize).toBe(8.5);
    const shrunk = fitTitle('INCOMPREHENSIBILITIES', 8.5, frame, { upper: true, padEm: 0.3 });
    expect(shrunk.text).toBe('INCOMPREHENSIBILITIES');
    expect(shrunk.fontSize).toBeLessThan(8.5);
  });

  it('titles are kept out of the app-button zones', () => {
    const e = edit();
    e.elements.find((x) => x.type === 'text')!.y = '92%';
    expect(editProblems(e).join(' ')).toMatch(/app buttons/);
  });

  it('cutaways show other footage over a piece while its sound plays on (track 2, muted)', () => {
    const e = compileEdit({ original, brief, sources: [source()], segments: [{ source: 'S1', from: 3, to: 9 }], cutaways: [{ piece: 1, at: 2, length: 3, source: 'S1', from: 45 }, { piece: 1, at: 5, length: 9, source: 'S1', from: 50 }] });
    const over = e.elements.filter((x) => (e.groups.cutaways ?? []).includes(x.id));
    // The second runs past its piece: cut to fit (1 s)
    expect(over.map((c) => [c.track, c.time, c.trimStart, c.trimDuration, c.muted])).toEqual([[2, 2, 45, 3, true], [2, 5, 50, 1, true]]);
    expect(e.elements.find((x) => x.track === 1)).toMatchObject({ trimStart: 3, trimDuration: 6, muted: false });
    expect(editProblems(e)).toEqual([]);
    expect(cutProblems([{ source: 'S1', from: 3, to: 9 }], [source()], undefined, [{ piece: 2, at: 0, length: 1, source: 'S1', from: 0 }]).join(' ')).toMatch(/no piece #2/);
  });

  it('the storyboard looks at the opening, each piece, each title and the end', () => {
    const e = compileEdit({ original, brief, sources: [source()], segments: [{ source: 'S1', from: 3, to: 6 }, { source: 'S1', from: 39, to: 46 }], type: { titles: [{ text: 'LISBON', start: 5, end: 7, role: 'label', position: 'upper', style: 'bold', motion: 'pop' }], captions: { use: false, style: 'clean', position: 'lower' }, notes: '' } });
    expect(storyboardTimes(e).map((f) => [Number(f.time.toFixed(2)), f.label])).toEqual([[0.4, 'the opening (hook)'], [1.5, 'piece #1'], [5.7, 'title "LISBON"'], [6.5, 'piece #2'], [9.7, 'the ending']]);
  });

  it('spreads a sentence over its time when there are no word timings', () => {
    expect(wordsFromLines([{ start: 0, end: 2, text: 'one two' }])).toEqual([{ text: 'one', start: 0, end: 1 }, { text: 'two', start: 1, end: 2 }]);
  });
});

describe('Director runs', () => {
  const requests: GeminiRequest[] = [];
  const answer = (req: GeminiRequest): unknown => {
    if (req.system.includes('director of a world-class')) return brief;
    if (req.system.includes('You are the story editor')) return { segments: [{ source: 'S1', from: '0:03', to: '0:06' }, { source: 'S1', from: '0:39', to: '0:46' }], notes: 'n' };
    if (req.system.includes('typographer')) return { titles: [{ text: 'LISBON', start: 0, end: 2, role: 'hook', position: 'upper', style: 'bold', motion: 'pop' }], captions: { use: true, style: 'word-pop', position: 'lower' }, notes: '' };
    if (req.system.includes('motion designer')) return { pieces: [{ piece: 1, move: 'punch-in', transitionIn: 'cut' }], notes: '' };
    if (req.system.includes('sound designer')) return { originalAudio: 'keep', sfx: [{ at: 3, kind: 'whoosh' }], music: { use: false, mood: '', prompt: '' }, notes: '' };
    throw new Error(`unexpected prompt: ${req.system.slice(0, 60)}`);
  };
  const fake = {
    generate: vi.fn(async (req: GeminiRequest): Promise<GeminiResult> => {
      requests.push(req);
      const json = answer(req);
      return { text: JSON.stringify(json), json, calls: [], usage: { input: 1, output: 1 }, model: req.model };
    }),
  };
  const sfx = vi.fn(async () => Buffer.from('mp3'));

  beforeEach(() => {
    requests.length = 0;
    setGeminiClient(fake);
    setAudioTools({ soundEffect: sfx } as any);
  });
  afterEach(() => {
    setGeminiClient(null);
    setAudioTools(null);
  });

  async function setup(plan?: string) {
    const { user, token } = await createUser();
    if (plan) await (await import('../src/models/User')).User.updateOne({ _id: user._id }, { $set: { 'subscription.plan': plan } });
    const file = await File.create({ userId: user._id, name: 'lisbon.mp4', originalName: 'lisbon.mp4', mimeType: 'video/mp4', size: 10, storageKey: `users/${user._id}/uploads/v.mp4`, cdnUrl: 'https://cdn.test/v.mp4', status: 'ready', source: 'upload', metadata: { duration: 60 } });
    // Watched already, so the run doesn't need ffmpeg
    await MediaAnalysis.create({ fileId: file._id, userId: user._id, version: MEDIA_ANALYSIS_VERSION, status: 'ready', analysedSeconds: 60, duration: 60, modelName: 'test', speechSource: 'model', result: analysis });
    const body = { projectId: 'p1', request: 'Turn this into a punchy 10 second reel', context: 'c1 video', project: { project: original.project, elements: [{ ...original.elements[0], fileId: String(file._id) }] } };
    return { user, token, file, body };
  }

  const waitFor = async (token: string, id: string) => {
    // Up to ~15 s: runs are quick with fakes, but a busy machine slows them
    for (let i = 0; i < 500; i++) {
      const res = await api().get(`/api/v1/ai/director/${id}`).set('Authorization', `Bearer ${token}`);
      if (['done', 'failed', 'stopped'].includes(res.body.run.stage)) return res.body.run;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('run did not finish');
  };

  it('watches, briefs, cuts, crafts and assembles a draft, metered as one run', async () => {
    const { user, token, body } = await setup();
    const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(202);
    const run = await waitFor(token, res.body.run.id);
    expect(run.stage).toBe('done');
    expect(run.events.map((e: any) => e.stage)).toEqual(expect.arrayContaining(['watching', 'briefing', 'cutting', 'crafting', 'assembling', 'done']));
    expect(run.result.project).toMatchObject({ width: 1080, height: 1920, duration: 10 });
    expect(run.result.groups.cut).toHaveLength(2);
    expect(run.result.groups.sound).toHaveLength(1);
    expect(run.result.summary.understood).toBe('A 10 second reel');
    // The director thinks hard on the strong model; specialists are fast
    expect(requests.find((r) => r.system.includes('director of a world-class'))).toMatchObject({ thinking: 'high' });
    expect(sfx).toHaveBeenCalledTimes(1);
    const counter = await UsageCounter.findOne({ userId: user._id, kind: 'directorRuns', period: currentPeriod() });
    expect(counter?.total).toBe(1);
    // Captions were asked for: the speech was transcribed (once, kept) and its words used
    expect(transcribe).toHaveBeenCalled();
    const caption = run.result.elements.find((e: any) => e.type === 'caption');
    expect(caption.transcription.words.map((w: any) => w.word)).toEqual(['Good', 'morning']);
  });

  it('the director reviews real frames and sends notes back until it is good enough', async () => {
    const { token, body } = await setup();
    const rendered: number[] = [];
    setStillRenderer(async (_edit, frame) => {
      rendered.push(frame);
      return Buffer.from('jpeg');
    });
    let reviews = 0;
    const base = fake.generate.getMockImplementation()!;
    fake.generate.mockImplementation(async (req: GeminiRequest) => {
      if (!req.system.includes('reviewing your crew')) return base(req);
      requests.push(req);
      reviews++;
      const json = reviews === 1
        ? { score: 5, verdict: 'revise', strengths: ['Good hook'], issues: [{ who: 'type', problem: 'Title too small', fix: 'Make it bigger' }], notes: { type: 'Bigger hook title' } }
        : { score: 8, verdict: 'ship', strengths: ['Lands'], issues: [], notes: {} };
      return { text: JSON.stringify(json), json, calls: [], usage: { input: 1, output: 1 }, model: req.model };
    });
    try {
      const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
      const run = await waitFor(token, res.body.run.id);
      expect(run.stage).toBe('done');
      expect(reviews).toBe(2);
      // The reviewer saw the frames as images
      const review = requests.find((r) => r.system.includes('reviewing your crew'))!;
      expect(review.messages[0].media?.length).toBeGreaterThan(2);
      expect(review.messages[0].media?.[0].mimeType).toBe('image/jpeg');
      // Only the typographer redid its part, with the notes
      const typeCalls = requests.filter((r) => r.system.includes('typographer'));
      expect(typeCalls).toHaveLength(2);
      expect(typeCalls[1].messages[0].text).toContain('Bigger hook title');
      expect(requests.filter((r) => r.system.includes('You are the story editor'))).toHaveLength(1);
      expect(requests.filter((r) => r.system.includes('motion designer'))).toHaveLength(1);
      expect(run.events.map((e: any) => e.text)).toEqual(expect.arrayContaining(['Score 5/10: Title too small', 'Revising: titles and captions', 'Score 8/10']));
      expect(run.result.review).toMatchObject({ score: 8, rounds: 2 });
      expect(run.result.storyboard[0].url).toMatch(/^https:\/\/cdn\.test\/users\/.+\/director\//);
    } finally {
      setStillRenderer(null);
      fake.generate.mockImplementation(base);
    }
  });

  it('when a revision comes out worse, the better draft the director judged is the one kept', async () => {
    const { token, body } = await setup();
    setStillRenderer(async () => Buffer.from('jpeg'));
    let reviews = 0;
    const base = fake.generate.getMockImplementation()!;
    fake.generate.mockImplementation(async (req: GeminiRequest) => {
      if (!req.system.includes('reviewing your crew')) return base(req);
      reviews++;
      const json = reviews === 1
        ? { score: 7, verdict: 'revise', strengths: ['Strong hook'], issues: [{ who: 'type', problem: 'Title a bit late', fix: 'Earlier' }], notes: { type: 'Earlier title' } }
        : { score: 5, verdict: 'revise', strengths: [], issues: [{ who: 'type', problem: 'Worse now', fix: '-' }], notes: {} };
      return { text: '', json, calls: [], usage: { input: 1, output: 1 } };
    });
    try {
      const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
      const run = await waitFor(token, res.body.run.id);
      expect(reviews).toBe(2);
      expect(run.result.review).toMatchObject({ score: 7, strengths: ['Strong hook'], rounds: 2 });
      expect(run.result.storyboard[0].url).toContain('/r1-');
    } finally {
      setStillRenderer(null);
      fake.generate.mockImplementation(base);
    }
  });

  it('music the sound designer asks for is made to the edit\'s length and laid under it', async () => {
    const { token, body } = await setup();
    const music = vi.fn(async () => Buffer.from('mp3'));
    setAudioTools({ soundEffect: sfx, music } as any);
    const base = fake.generate.getMockImplementation()!;
    fake.generate.mockImplementation(async (req: GeminiRequest) => {
      if (!req.system.includes('sound designer')) return base(req);
      const json = { originalAudio: 'keep', sfx: [], music: { use: true, mood: 'upbeat travel pop', prompt: 'upbeat travel pop, 120 bpm' }, notes: '' };
      return { text: '', json, calls: [], usage: { input: 1, output: 1 } };
    });
    try {
      const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
      const run = await waitFor(token, res.body.run.id);
      expect(music).toHaveBeenCalledWith('upbeat travel pop, 120 bpm', 11);
      const bed = run.result.elements.find((e: any) => e.name === 'Music');
      // Under speech it stays low
      expect(bed).toMatchObject({ type: 'audio', time: 0, volume: 22 });
      expect(run.result.groups.music).toEqual([bed.id]);
    } finally {
      fake.generate.mockImplementation(base);
    }
  });

  it('a second sound effect of the same kind reuses the first file', async () => {
    const { token, body } = await setup();
    const first = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    await waitFor(token, first.body.run.id);
    const second = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    await waitFor(token, second.body.run.id);
    expect(sfx).toHaveBeenCalledTimes(1);
  });

  it('free plan: 3 runs a month', async () => {
    const { token, body } = await setup();
    for (let i = 0; i < 3; i++) {
      const r = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
      expect(r.status).toBe(202);
      await waitFor(token, r.body.run.id);
    }
    const over = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    expect(over.status).toBe(403);
    expect(JSON.stringify(over.body)).toMatch(/DIRECTOR_RUNS_EXCEEDED/);
  });

  it('a failed run is refunded; runs are private', async () => {
    const { user, token, body } = await setup();
    fake.generate.mockImplementationOnce(async () => {
      throw new Error('Vertex down');
    });
    const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    const run = await waitFor(token, res.body.run.id);
    expect(run.stage).toBe('failed');
    expect(run.error).toMatch(/couldn't finish/);
    const counter = await UsageCounter.findOne({ userId: user._id, kind: 'directorRuns', period: currentPeriod() });
    expect(counter?.total ?? 0).toBe(0);
    const other = await createUser();
    const peek = await api().get(`/api/v1/ai/director/${res.body.run.id}`).set('Authorization', `Bearer ${other.token}`);
    expect(peek.status).toBe(404);
  });

  it('can be stopped; one run at a time per project', async () => {
    const { token, body } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.generate.mockImplementationOnce(async (req: GeminiRequest) => {
      await gate;
      const json = answer(req);
      return { text: '', json, calls: [], usage: { input: 1, output: 1 } };
    });
    const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    const busy = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${token}`).send(body);
    expect(busy.status).toBe(409);
    await api().post(`/api/v1/ai/director/${res.body.run.id}/stop`).set('Authorization', `Bearer ${token}`);
    release();
    const run = await waitFor(token, res.body.run.id);
    expect(run.stage).toBe('stopped');
    expect(await DirectorRun.countDocuments({ stage: 'done' })).toBe(0);
  });

  it("only the user's own files are watched", async () => {
    const { token, body } = await setup();
    const other = await createUser();
    const res = await api().post('/api/v1/ai/director').set('Authorization', `Bearer ${other.token}`).send(body);
    const run = await waitFor(other.token, res.body.run.id);
    expect(run.events.map((e: any) => e.text).join(' ')).toMatch(/Could not watch|No footage/);
    expect(requests.some((r) => r.system.includes('You are the story editor'))).toBe(false);
    expect(token).toBeTruthy();
  });
});

describe('the latest run in a project', () => {
  it("is found for the panel to pick up, only the user's own", async () => {
    const { user, token } = await createUser();
    const other = await createUser();
    await DirectorRun.create({ userId: user._id, projectId: 'p9', request: 'reel', stage: 'cutting', events: [], usageJobId: 'x1' });
    const mine = await api().get('/api/v1/ai/director?projectId=p9').set('Authorization', `Bearer ${token}`);
    expect(mine.body.run).toMatchObject({ stage: 'cutting', request: 'reel', result: null });
    const theirs = await api().get('/api/v1/ai/director?projectId=p9').set('Authorization', `Bearer ${other.token}`);
    expect(theirs.body.run).toBeNull();
  });
});

describe('preparing footage ahead of a run', () => {
  it("watches the user's own files in the background, once", async () => {
    const { setGeminiClient: set } = await import('../src/services/ai/gemini');
    const { user, token } = await createUser();
    const other = await createUser();
    const file = await File.create({ userId: user._id, name: 'a.mp4', originalName: 'a.mp4', mimeType: 'video/mp4', size: 1, storageKey: `users/${user._id}/uploads/a.mp4`, cdnUrl: 'https://cdn.test/a.mp4', status: 'ready', source: 'upload', metadata: { duration: 10 } });
    await MediaAnalysis.create({ fileId: file._id, userId: user._id, version: MEDIA_ANALYSIS_VERSION, status: 'ready', analysedSeconds: 10, duration: 10, modelName: 't', speechSource: 'none', result: analysis });
    const generate = vi.fn();
    set({ generate } as any);
    const res = await api().post('/api/v1/ai/director/prepare').set('Authorization', `Bearer ${token}`).send({ fileIds: [String(file._id)] });
    expect(res.status).toBe(202);
    // Someone else's file id is ignored (not theirs to watch)
    const theirs = await api().post('/api/v1/ai/director/prepare').set('Authorization', `Bearer ${other.token}`).send({ fileIds: [String(file._id)] });
    expect(theirs.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    // Already watched: nothing new asked of the model
    expect(generate).not.toHaveBeenCalled();
    set(null);
  });
});

describe('cuts follow what is said', () => {
  it('a piece ending mid-sentence runs on to the end of it; a start mid-sentence moves back to its start', async () => {
    const { snapToSpeech } = await import('../src/services/director/sources');
    const s = { ...{ ref: 'S1', fileId: 'f', name: 'n', kind: 'video' as const, url: 'u', duration: 60, element: {} }, analysis: { ...analysis, speech: [{ start: 10, end: 14, text: 'like the Pyramids in Egypt.' }, { start: 20, end: 30, text: 'a very long sentence that goes on' }] } };
    expect(snapToSpeech([{ source: 'S1', from: 5, to: 13.2 }], [s])).toEqual([{ source: 'S1', from: 5, to: 14.15 }]);
    // Too far to the end (5 s): back to the end of the sentence before
    expect(snapToSpeech([{ source: 'S1', from: 5, to: 25 }], [s])).toEqual([{ source: 'S1', from: 5, to: 14.1 }]);
    // More than a second to go and no sentence before it in the piece: left as chosen
    expect(snapToSpeech([{ source: 'S1', from: 5, to: 12.5 }], [s])).toEqual([{ source: 'S1', from: 5, to: 12.5 }]);
    // Starts stay where the story editor put them
    expect(snapToSpeech([{ source: 'S1', from: 11, to: 16 }, { source: 'S1', from: 20, to: 30 }], [s])[0]).toEqual({ source: 'S1', from: 11, to: 16 });
    // The last piece ends just after its last words instead of lingering
    expect(snapToSpeech([{ source: 'S1', from: 5, to: 13.2 }, { source: 'S1', from: 9, to: 17 }], [s])[1]).toEqual({ source: 'S1', from: 9, to: 14.35 });
  });
});

describe('what users do with drafts', () => {
  it('records applied (with parts left out), rating and undo; export marks the latest applied edit', async () => {
    const { markDirectorExport } = await import('../src/services/director/outcomes');
    const { user, token } = await createUser();
    const other = await createUser();
    const run = await DirectorRun.create({ userId: user._id, projectId: 'p5', request: 'reel', stage: 'done', events: [], usageJobId: 'o1' });
    const post = (body: unknown, t = token) => api().post(`/api/v1/ai/director/${run._id}/outcome`).set('Authorization', `Bearer ${t}`).send(body);
    expect((await post({ event: 'applied', leftOut: ['sound', 'titles'] })).status).toBe(204);
    expect((await post({ event: 'rated', rating: -1, comment: 'Too many sound effects' })).status).toBe(204);
    expect((await post({ event: 'rated', rating: 5 })).status).toBe(400);
    expect((await post({ event: 'applied' }, other.token)).status).toBe(404);
    await markDirectorExport(user._id, 'p5');
    const saved = await DirectorRun.findById(run._id).lean();
    expect(saved?.outcome).toMatchObject({ leftOut: ['sound', 'titles'], rating: -1, comment: 'Too many sound effects' });
    expect(saved?.outcome?.applied).toBeTruthy();
    expect(saved?.outcome?.exported).toBeTruthy();
    // Undone edits are never counted as exported
    const undone = await DirectorRun.create({ userId: user._id, projectId: 'p6', request: 'reel', stage: 'done', events: [], usageJobId: 'o2', outcome: { applied: new Date(), undone: new Date() } });
    await markDirectorExport(user._id, 'p6');
    expect((await DirectorRun.findById(undone._id).lean())?.outcome?.exported).toBeUndefined();
  });
});
