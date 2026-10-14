// services/director/compile.ts
//
// Turns the crew's decisions into the project the editor and the export
// render: the cut as video clips back to back on track 1 (cover-fit, full
// frame), moves as keyframes, transitions on the incoming clip (overlapping
// the previous one), titles as text, captions as one caption element with
// the spoken words moved onto the new timeline, sound effects and music as
// audio. The models only pick words from a fixed vocabulary; every number
// the renderer reads is set here.
//
// Elements are grouped (cut, titles, captions, motion, sound, music, extras)
// so the editor can offer each part to leave out.

import { v4 as uuidv4 } from 'uuid';
import type { AnalysisLine } from '../../models/MediaAnalysis';
import type { Brief, MotionPart, SoundPart, TypePart } from './crew';
import { placeSegments, type Cutaway, type ProjectJson, type Segment, type Source } from './sources';

export type Group = 'cut' | 'backdrops' | 'cutaways' | 'titles' | 'captions' | 'motion' | 'sound' | 'music' | 'extras' | 'kept';

export interface CompiledEdit extends ProjectJson {
  /** Element ids (or, for motion, ids of the clips that carry it) per group */
  groups: Partial<Record<Group, string[]>>;
  /** What could not be made, said plainly (e.g. music needs a track) */
  notes: string[];
}

/** A generated sound effect or music file */
export interface AudioAsset {
  url: string;
  fileId: string;
  duration: number;
}

/** A stock or generated picture placed by the asset scout */
export interface VisualAsset {
  kind: 'image' | 'video';
  url: string;
  fileId: string;
  duration?: number;
  start: number;
  end: number;
  placement: 'fullscreen' | 'overlay';
}

export interface CompileInput {
  original: ProjectJson;
  brief: Brief;
  sources: Source[];
  segments: Segment[];
  cutaways?: Cutaway[];
  type?: TypePart;
  motion?: MotionPart;
  sound?: SoundPart;
  sfx?: Array<{ at: number; asset: AudioAsset }>;
  music?: AudioAsset;
  visuals?: VisualAsset[];
  /** Word-level transcripts by file id (exact captions); otherwise sentences are spread over their time */
  words?: Record<string, Array<{ text: string; start: number; end: number }>>;
}

const FRAMES: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
};

const TRANSITION_IDS: Record<string, string> = {
  crossfade: 'fade',
  whip: 'whip-pan',
  zoom: 'cross-zoom',
  flash: 'flash',
  slide: 'slide',
  glitch: 'glitch',
  blur: 'blur-dissolve',
};
const TRANSITION_SECONDS = 0.3;
/** How much larger wide footage with burned-in captions is set, to push them below a tall frame */
const BURNED_CAPTION_ZOOM = 1.2;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const id = (kind: string) => `cue-${kind}-${uuidv4()}`;

export function frameFor(aspect: string, original: ProjectJson) {
  return FRAMES[aspect] ?? { width: Number(original.project.width) || 1920, height: Number(original.project.height) || 1080 };
}

/** Vertical positions (% from top), kept out of the app-button zones on tall frames */
function yFor(position: string, tall: boolean): number {
  const table: Record<string, number> = tall
    ? { top: 18, upper: 30, center: 50, lower: 66, bottom: 74 }
    : { top: 14, upper: 28, center: 50, lower: 70, bottom: 84 };
  return table[position] ?? 50;
}

function moveKeyframes(move: string, length: number): { keyframes?: Record<string, unknown>; animations?: unknown[] } {
  const L = r3(length);
  switch (move) {
    case 'punch-in':
      return { keyframes: { scale: [{ time: 0, value: 118, easing: 'hold' }] } };
    case 'slow-zoom-in':
      return { keyframes: { scale: [{ time: 0, value: 100, easing: 'linear' }, { time: L, value: 112 }] } };
    case 'slow-zoom-out':
      return { keyframes: { scale: [{ time: 0, value: 112, easing: 'linear' }, { time: L, value: 100 }] } };
    case 'zoom-out-reveal':
      return { keyframes: { scale: [{ time: 0, value: 135, easing: 'ease-out' }, { time: r3(Math.min(1.2, L)), value: 100 }] } };
    case 'pan-left':
      return { keyframes: { scale: [{ time: 0, value: 116, easing: 'hold' }], x: [{ time: 0, value: 54, easing: 'linear' }, { time: L, value: 46 }] } };
    case 'pan-right':
      return { keyframes: { scale: [{ time: 0, value: 116, easing: 'hold' }], x: [{ time: 0, value: 46, easing: 'linear' }, { time: L, value: 54 }] } };
    case 'shake':
      return { animations: [{ id: uuidv4(), type: 'camera-shake', category: 'emphasis', duration: r3(Math.min(0.6, L)), easing: 'linear', params: {}, startTime: 0, repeat: 1 }] };
    default:
      return {};
  }
}

const TEXT_ENTER: Record<string, { type: string; params?: Record<string, unknown>; duration: number; easing: string }> = {
  pop: { type: 'pop', duration: 0.35, easing: 'back-out' },
  'slide-up': { type: 'rise', duration: 0.4, easing: 'cubic-out' },
  fade: { type: 'text-fade', duration: 0.4, easing: 'quadratic-out' },
  zoom: { type: 'zoom-punch', duration: 0.4, easing: 'exponential-out' },
  typewriter: { type: 'text-typewriter', duration: 0.6, easing: 'linear' },
  'word-by-word': { type: 'text-slide', params: { split: 'word' }, duration: 0.5, easing: 'cubic-out' },
};

/** About how wide `text` sets, in em (bold sans; capitals are wider) */
export function textWidthEm(text: string, upper: boolean): number {
  let em = 0;
  for (const ch of upper ? text.toUpperCase() : text) {
    if (ch === ' ') em += 0.28;
    else if (/[MWmw@]/.test(ch)) em += upper ? 0.92 : 0.84;
    else if (/[IJijl1.,:;'!|]/.test(ch)) em += 0.32;
    else if (/[A-Z0-9#%&?]/.test(ch)) em += upper ? 0.7 : 0.66;
    else em += 0.56;
  }
  return em;
}

/**
 * A title that fits its frame: one line if it can, else broken into two at
 * the most even space, and only then a smaller size. (A title wider than its
 * box spilled past its background.)
 */
export function fitTitle(text: string, fontSize: number, frame: { width: number; height: number }, opts: { upper: boolean; padEm: number; maxWidth?: number }): { text: string; fontSize: number } {
  const fontPx = (fontSize / 100) * Math.min(frame.width, frame.height);
  const room = (opts.maxWidth ?? 0.86) * frame.width;
  const widthOf = (lines: string[]) => (Math.max(...lines.map((l) => textWidthEm(l, opts.upper))) + opts.padEm * 2) * fontPx;
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim();
  let lines = text.includes('\n') ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [oneLine];
  if (widthOf(lines) > room && lines.length === 1) {
    const words = oneLine.split(' ');
    let best: string[] = lines;
    for (let i = 1; i < words.length; i++) {
      const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      if (widthOf(pair) < widthOf(best)) best = pair;
    }
    lines = best;
  }
  const width = widthOf(lines);
  const size = width > room ? Math.max(3, fontSize * (room / width)) : fontSize;
  return { text: lines.join('\n'), fontSize: Math.round(size * 100) / 100 };
}

const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fallback);

function titleStyle(style: string, color: string, accent: string, hook: boolean): Record<string, unknown> {
  const base = { fontFamily: 'Inter', fontStyle: 'normal', lineHeight: 1.1, letterSpacing: 0, textAlign: 'center', verticalAlign: 'middle', textTransform: 'uppercase', fontSize: hook ? 8.5 : 6.5 };
  switch (style) {
    case 'boxed':
      return { ...base, fontWeight: '800', fillColor: color, backgroundColor: accent, backgroundXPadding: 30, backgroundYPadding: 16, backgroundBorderRadius: 12 };
    case 'outline':
      return { ...base, fontWeight: '900', fillColor: color, strokeEnabled: true, strokeColor: '#000000', strokeWidth: 6 };
    case 'highlight':
      return { ...base, fontWeight: '900', fillColor: '#111111', backgroundColor: accent, backgroundXPadding: 24, backgroundYPadding: 10, backgroundBorderRadius: 6 };
    case 'minimal':
      return { ...base, fontWeight: '600', textTransform: 'none', fontSize: hook ? 6.5 : 5, fillColor: color, shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.6, shadowOffsetX: 0, shadowOffsetY: 2, shadowBlur: 8 };
    default:
      return { ...base, fontWeight: '900', fillColor: color, shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.55, shadowOffsetX: 0, shadowOffsetY: 3, shadowBlur: 10 };
  }
}

const CAPTION_LOOKS: Record<string, Record<string, unknown>> = {
  'word-pop': { displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1, highlightStyle: 'color', highlightColor: '#FFE14D', fontWeight: 900, textTransform: 'uppercase', strokeColor: '#000000', strokeWidth: 5, wordAnimation: { type: 'caption-word-pop', duration: 0.2 } },
  karaoke: { displayMode: 'karaoke', wordsPerLine: 4, linesPerPage: 1, highlightStyle: 'color', highlightColor: '#4DE1FF', fontWeight: 800, textTransform: 'none', strokeColor: '#000000', strokeWidth: 4 },
  clean: { displayMode: 'line', wordsPerLine: 4, linesPerPage: 1, highlightStyle: 'none', fontWeight: 600, textTransform: 'none', strokeColor: '#000000', strokeWidth: 0, shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.7, shadowBlur: 8 },
  'bold-box': { displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1, highlightStyle: 'background', highlightColor: '#FFFFFF', highlightBackgroundColor: '#2447F9', fontWeight: 900, textTransform: 'uppercase', strokeColor: '#000000', strokeWidth: 3 },
};

/** Sentences → words spread evenly over each sentence (when there is no word-level transcript) */
export function wordsFromLines(lines: AnalysisLine[]): Array<{ text: string; start: number; end: number }> {
  const words: Array<{ text: string; start: number; end: number }> = [];
  for (const l of lines) {
    const parts = l.text.split(/\s+/).filter(Boolean);
    const step = (l.end - l.start) / Math.max(1, parts.length);
    parts.forEach((text, i) => words.push({ text, start: l.start + i * step, end: l.start + (i + 1) * step }));
  }
  return words;
}

const MAX_SOURCE_PEEK = 0.05;

export function compileEdit(input: CompileInput): CompiledEdit {
  const { original, brief, sources } = input;
  const frame = frameFor(brief.aspect, original);
  const tall = frame.height > frame.width;
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const groups: CompiledEdit['groups'] = {};
  const add = (g: Group, elementId: string) => (groups[g] ??= []).push(elementId);
  const notes: string[] = [];
  const elements: Array<Record<string, any>> = [];

  const originalAudio = input.sound?.originalAudio ?? 'keep';
  const placed = placeSegments(input.segments.filter((s) => byRef.has(s.source) && s.to > s.from));
  const total = placed.reduce((t, p) => Math.max(t, p.at + p.length), 0);

  // --- The cut: clips back to back on track 1 ---
  const clips: Array<Record<string, any>> = [];
  placed.forEach((p, i) => {
    const src = byRef.get(p.source)!;
    const template = src.element;
    const clip: Record<string, any> = {
      id: id('clip'),
      type: src.kind,
      name: `${src.name.replace(/\.[a-z0-9]+$/i, '')} · ${i + 1}`,
      source: src.url,
      fileId: src.fileId,
      track: 1,
      time: r3(p.at),
      duration: r3(src.duration || p.to),
      trimStart: r3(p.from),
      trimDuration: r3(p.length),
      speed: 100,
      volume: originalAudio === 'lower' ? 35 : 100,
      muted: originalAudio === 'mute',
      loop: false,
      x: '50%',
      y: '50%',
      width: '100%',
      height: src.kind === 'audio' ? '4.17%' : '100%',
      anchorX: 50,
      anchorY: 50,
      scaleX: '100%',
      scaleY: '100%',
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      ...(src.kind === 'video' ? { fit: 'cover' } : {}),
      // Keep the look the user gave the clip (colour filters…)
      ...(template.colorFilterEnabled ? { colorFilterEnabled: true, colorFilter: template.colorFilter, colorFilterValue: template.colorFilterValue } : {}),
    };
    clips.push(clip);
    elements.push(clip);
    add('cut', clip.id);
  });

  // --- Motion: moves and transitions on the clips ---
  for (const m of input.motion?.pieces ?? []) {
    const i = Number(m.piece) - 1;
    const clip = clips[i];
    if (!clip || clip.type !== 'video') continue;
    const length = placed[i].length;
    const move = moveKeyframes(m.move, length);
    if (move.keyframes) clip.keyframes = move.keyframes;
    if (move.animations) clip.animations = move.animations;
    const transition = TRANSITION_IDS[m.transitionIn];
    if (transition && i > 0) {
      // The incoming clip overlaps the previous one by the transition's length:
      // the previous clip plays on a little (if its source has more), else this one starts earlier
      const prev = clips[i - 1];
      const prevSrc = byRef.get(placed[i - 1].source)!;
      const room = (prevSrc.duration || 0) - (prev.trimStart + prev.trimDuration);
      if (room >= TRANSITION_SECONDS - MAX_SOURCE_PEEK) {
        prev.trimDuration = r3(prev.trimDuration + TRANSITION_SECONDS);
      } else if (length > TRANSITION_SECONDS * 3) {
        clip.time = r3(clip.time - TRANSITION_SECONDS);
        clip.trimDuration = r3(clip.trimDuration + TRANSITION_SECONDS);
        clip.trimStart = r3(Math.max(0, clip.trimStart - TRANSITION_SECONDS));
      } else continue;
      clip.transition = { id: uuidv4(), type: transition, category: 'transition', duration: TRANSITION_SECONDS, easing: 'quadratic-in-out', params: {}, transition: true, isExit: false };
    }
    if (move.keyframes || move.animations || clip.transition) add('motion', clip.id);
  }


  // --- Framing: footage of another shape (wide footage in a tall frame) ---
  const frameAspect = frame.width / frame.height;
  let hidBurnedCaptions = false;
  placed.forEach((p, i) => {
    const clip = clips[i];
    const src = byRef.get(p.source)!;
    if (clip.type !== 'video' || !src.width || !src.height) return;
    const sourceAspect = src.width / src.height;
    if (Math.abs(sourceAspect - frameAspect) / frameAspect < 0.08) return;
    const shots = src.analysis?.shots.filter((x) => x.end > p.from && x.start < p.to) ?? [];
    const asked = input.motion?.pieces.find((m) => Number(m.piece) === i + 1)?.framing;
    const textInPicture = shots.some((x) => x.onScreenText) || !!src.analysis?.hasBurnedCaptions;
    const group = shots.some((x) => (x.people ?? 0) >= 3);
    // Captions burned into the footage: crop past them (zoomed so their band at the bottom is out of
    // frame) and caption afresh, rather than letterbox the whole reel or chop the old captions
    const burned = !!src.analysis?.hasBurnedCaptions && sourceAspect > frameAspect;
    const fit = !burned && (asked === 'fit' || ((!asked || asked === 'auto') && (textInPicture || group) && sourceAspect > frameAspect));
    if (fit) {
      // The whole picture, over a blurred, enlarged copy of itself that fills the frame
      const backdrop = {
        ...clip,
        id: id('backdrop'),
        name: `${clip.name} · backdrop`,
        // Its own span only (the clip may run on under a transition)
        trimDuration: r3(p.length),
        muted: true,
        volume: 0,
        fit: 'cover',
        blurEnabled: true,
        blurRadius: 40,
        scaleX: '112%',
        scaleY: '112%',
        keyframes: undefined,
        animations: undefined,
        transition: undefined,
      };
      elements.push(backdrop);
      add('backdrops', backdrop.id);
      clip.fit = 'contain';
      return;
    }
    // Crop: the box keeps the footage's shape and slides so the subject is in frame;
    // it scales about the frame's centre, so moves stay on the subject
    const xs = shots.map((x) => Number(x.subjectX)).filter((v) => v >= 0 && v <= 1);
    const focus = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5;
    if (sourceAspect > frameAspect) {
      // Past burned captions: 20% larger, top-anchored, so the bottom sixth of the footage is below the frame
      const zoom = burned ? BURNED_CAPTION_ZOOM : 1;
      if (burned) {
        clip.height = `${r3(100 * zoom)}%`;
        clip.y = '0%';
        clip.anchorY = 0;
        hidBurnedCaptions = true;
      }
      const W = (sourceAspect / frameAspect) * 100 * zoom;
      const left = Math.max(100 - W, Math.min(0, 50 - focus * W));
      clip.width = `${r3(W)}%`;
      clip.anchorX = r3(((50 - left) / W) * 100);
      // A pan slides within what the footage has either side
      const room = { left: -left, right: left + W - 100 };
      if (clip.keyframes?.x) {
        // Same direction as asked, only as far as the footage reaches
        const [from, to] = clip.keyframes.x;
        const direction = Math.sign(to.value - from.value) || -1;
        const span = Math.min(5, room.left, room.right);
        if (span < 0.5) delete clip.keyframes.x;
        else clip.keyframes.x = [{ ...from, value: r3(50 - direction * span) }, { ...to, value: r3(50 + direction * span) }];
      }
    } else {
      const H = (frameAspect / sourceAspect) * 100;
      clip.height = `${r3(H)}%`;
      clip.anchorY = 50;
      if (clip.keyframes?.x) delete clip.keyframes.x;
    }
  });

  // --- Cutaways: other footage over a piece while its sound plays on ---
  for (const c of input.cutaways ?? []) {
    const p = placed[c.piece - 1];
    const src = byRef.get(c.source);
    if (!p || !src || src.kind !== 'video') continue;
    const at = Math.max(0, Math.min(p.length - 0.4, c.at));
    const length = Math.min(c.length, p.length - at, (src.duration || Infinity) - c.from);
    if (!(length >= 0.4) || c.from < 0) continue;
    const el = {
      id: id('cutaway'),
      type: 'video',
      name: `${src.name.replace(/\.[a-z0-9]+$/i, '')} · cutaway`,
      source: src.url,
      fileId: src.fileId,
      track: 0,
      time: r3(p.at + at),
      duration: r3(src.duration || c.from + length),
      trimStart: r3(c.from),
      trimDuration: r3(length),
      speed: 100,
      volume: 0,
      muted: true,
      x: '50%',
      y: '50%',
      width: '100%',
      height: '100%',
      anchorX: 50,
      anchorY: 50,
      fit: 'cover',
      opacity: 1,
      visible: true,
      keyframes: { scale: [{ time: 0, value: 100, easing: 'linear' }, { time: r3(length), value: 108 }] },
    };
    elements.push(el);
    add('cutaways', el.id);
  }

  // --- Captions: the spoken words, moved onto the new timeline ---
  const cap = input.type?.captions;
  // Burned-in captions still in the picture: no second set. Cropped out of the picture: fresh ones
  const burnedShowing = !hidBurnedCaptions && placed.some((p) => byRef.get(p.source)?.analysis?.hasBurnedCaptions);
  if (burnedShowing && (cap?.use || brief.captions.use)) notes.push('Captions: your footage already has them burned in, so no second set was added.');
  if (!burnedShowing && (hidBurnedCaptions || cap?.use || (cap === undefined && brief.captions.use))) {
    const words: Array<{ word: string; startMs: number; endMs: number }> = [];
    for (const p of placed) {
      const src = byRef.get(p.source)!;
      const all = input.words?.[src.fileId] ?? wordsFromLines(src.analysis?.speech ?? []);
      for (const w of all) {
        const mid = (w.start + w.end) / 2;
        if (mid < p.from || mid >= p.to) continue;
        const start = Math.max(p.at, p.at + (w.start - p.from));
        const end = Math.min(p.at + p.length, p.at + (w.end - p.from));
        if (end - start < 0.03) continue;
        words.push({ word: w.text.trim(), startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
      }
    }
    if (words.length) {
      const look = CAPTION_LOOKS[cap?.style ?? brief.captions.style] ?? CAPTION_LOOKS['word-pop'];
      const caption = {
        id: id('captions'),
        type: 'caption',
        name: 'Captions',
        sourceElementId: clips[0]?.id,
        track: 0,
        time: 0,
        duration: r3(Math.max(...words.map((w) => w.endMs)) / 1000),
        transcription: { words, language: sources[0]?.analysis?.language || 'en' },
        fontSize: tall ? 6.5 : 4.5,
        fontFamily: 'Inter',
        fontStyle: 'normal',
        lineHeight: 1.2,
        letterSpacing: 0,
        fillColor: '#FFFFFF',
        x: '50%',
        y: `${yFor(cap?.position ?? 'lower', tall)}%`,
        width: '88%',
        height: '14%',
        opacity: 1,
        visible: true,
        pageEnter: { type: 'caption-page-pop', category: 'enter', duration: 0.2 },
        ...look,
        ...(cap?.highlightColor ? { highlightColor: hex(cap.highlightColor, String(look.highlightColor ?? '#FFE14D')) } : {}),
      };
      elements.push(caption);
      add('captions', caption.id);
    } else notes.push("Captions: nothing is said in the cut, so there are none.");
  }

  // --- Titles ---
  for (const t of input.type?.titles ?? []) {
    const start = Math.max(0, Math.min(total - 0.3, Number(t.start) || 0));
    const end = Math.max(start + 0.3, Math.min(total, Number(t.end) || start + 2));
    const enter = TEXT_ENTER[t.motion];
    const hook = /hook/i.test(t.role) || start < 0.5;
    const look = titleStyle(t.style, hex(t.color, '#FFFFFF'), hex(t.accent, '#2447F9'), hook);
    const padEm = look.backgroundColor ? ((Number(look.backgroundXPadding) || 0) / 100) : look.strokeEnabled ? 0.05 : 0;
    const fitted = fitTitle(t.text, Number(look.fontSize), frame, { upper: look.textTransform === 'uppercase', padEm });
    const text = {
      id: id('title'),
      type: 'text',
      name: `Title: ${t.text.slice(0, 30)}`,
      text: fitted.text,
      track: 0,
      time: r3(start),
      duration: r3(end - start),
      x: '50%',
      y: `${yFor(t.position, tall)}%`,
      width: '86%',
      height: '14%',
      sizingMode: 'auto-dimensions',
      opacity: 1,
      visible: true,
      ...look,
      fontSize: fitted.fontSize,
      ...(enter ? { enter: { id: uuidv4(), type: enter.type, category: 'enter', duration: enter.duration, easing: enter.easing, params: enter.params ?? {}, isExit: false, transition: false, reversed: false } } : {}),
      exit: { id: uuidv4(), type: 'fade', category: 'exit', duration: 0.2, easing: 'quadratic-out', params: {}, isExit: true, endOffset: 0 },
    };
    elements.push(text);
    add('titles', text.id);
  }

  // --- Extras: stock or generated pictures ---
  // Replacing the footage's picture: its clips are heard, not seen, and the pictures cover the
  // whole edit back to back (each runs on to the next; the first from 0, the last to the end)
  const replace = brief.picture === 'replace' && (input.visuals?.length ?? 0) > 0;
  let visuals = input.visuals ?? [];
  if (replace) {
    visuals = [...visuals].sort((a, b) => a.start - b.start).map((v, i, list) => ({ ...v, placement: 'fullscreen' as const, start: i === 0 ? 0 : v.start, end: i === list.length - 1 ? total : list[i + 1].start }));
    for (const c of clips) Object.assign(c, { opacityEnabled: true, opacity: 0 });
    for (const c of elements.filter((e) => (groups.cutaways ?? []).includes(e.id))) Object.assign(c, { opacityEnabled: true, opacity: 0 });
  } else if (brief.picture === 'replace') notes.push("Pictures: none could be found or made, so the footage's own picture shows.");
  for (const v of visuals) {
    const start = Math.max(0, Math.min(total - 0.3, v.start));
    const end = Math.max(start + 0.3, Math.min(total, v.end));
    const full = v.placement === 'fullscreen';
    const el: Record<string, any> = {
      id: id('extra'),
      type: v.kind,
      name: 'B-roll',
      source: v.url,
      fileId: v.fileId,
      track: 0,
      time: r3(start),
      x: '50%',
      y: full ? '50%' : '36%',
      width: full ? '100%' : '70%',
      height: full ? '100%' : tall ? '24%' : '40%',
      fit: 'cover',
      opacity: 1,
      visible: true,
      enter: { id: uuidv4(), type: full ? 'fade' : 'pop', category: 'enter', duration: 0.25, easing: 'quadratic-out', params: {}, isExit: false, transition: false, reversed: false },
      exit: { id: uuidv4(), type: 'fade', category: 'exit', duration: 0.2, easing: 'quadratic-out', params: {}, isExit: true, endOffset: 0 },
    };
    // A stock video shorter than its span loops to fill it
    if (v.kind === 'video') Object.assign(el, { duration: r3(v.duration || end - start), trimStart: 0, trimDuration: r3(end - start), loop: (v.duration || 0) < end - start - 0.05, muted: true, volume: 0, speed: 100 });
    else el.duration = r3(end - start);
    elements.push(el);
    add('extras', el.id);
  }

  // --- Sound effects and music ---
  for (const s of input.sfx ?? []) {
    const at = Math.max(0, Math.min(total - 0.1, s.at));
    const el = { id: id('sfx'), type: 'audio', name: 'Sound effect', source: s.asset.url, fileId: s.asset.fileId, track: 0, time: r3(at), duration: r3(s.asset.duration), trimStart: 0, trimDuration: r3(Math.min(s.asset.duration, total - at)), volume: 70, x: '50%', y: '50%', width: '100%', height: '4.17%', visible: true };
    elements.push(el);
    add('sound', el.id);
  }
  if (input.music) {
    const speech = sources.some((s) => s.analysis?.hasSpeech);
    const el = { id: id('music'), type: 'audio', name: 'Music', source: input.music.url, fileId: input.music.fileId, track: 0, time: 0, duration: r3(input.music.duration), trimStart: 0, trimDuration: r3(Math.min(input.music.duration, total)), volume: speech ? 22 : 60, audioFadeIn: 0.3, audioFadeOut: 1, x: '50%', y: '50%', width: '100%', height: '4.17%', visible: true };
    elements.push(el);
    add('music', el.id);
  } else if (input.sound?.music.use) notes.push(`Music: the sound designer wanted "${input.sound.music.mood}" but it couldn't be made. Add a track from your library under it.`);

  // --- The project's other layers, kept as they are when the brief says so ---
  if (brief.keepOtherLayers) {
    const used = new Set(sources.map((s) => s.fileId));
    let top = 0;
    for (const e of original.elements) {
      if ((e.type === 'video' || e.type === 'audio') && used.has(String(e.fileId))) continue;
      if (Number(e.time) >= total) continue;
      const kept: Record<string, any> = { ...e, track: ++top };
      elements.push(kept);
      add('kept', String(kept.id));
    }
  }

  // Tracks are set here, bottom to top: the cut, pictures, captions, titles, sounds, then kept layers.
  // Each overlay gets its own track (they may overlap in time; only the cut shares one)
  const order: Group[] = ['backdrops', 'cut', 'cutaways', 'extras', 'captions', 'titles', 'sound', 'music', 'kept'];
  const groupOf = new Map<string, Group>();
  for (const g of order) for (const elementId of groups[g] ?? []) if (!groupOf.has(elementId)) groupOf.set(elementId, g);
  // Shared tracks, bottom to top: blurred backdrops, the cut, cutaways (none of them overlap
  // within their group); every overlay above gets its own track
  const shared = (['backdrops', 'cut', 'cutaways'] as Group[]).filter((g) => groups[g]?.length);
  let nextTrack = shared.length + 1;
  const sorted = [...elements].sort((a, b) => order.indexOf(groupOf.get(a.id) ?? 'kept') - order.indexOf(groupOf.get(b.id) ?? 'kept'));
  for (const el of sorted) {
    const g = groupOf.get(el.id)!;
    el.track = shared.includes(g) ? shared.indexOf(g) + 1 : nextTrack++;
  }

  const duration = Math.ceil(Math.max(total, ...elements.map((e) => (Number(e.time) || 0) + clipLength(e))) * 100) / 100;
  return {
    project: { ...original.project, width: frame.width, height: frame.height, duration, backgroundColor: hex(original.project.backgroundColor, '#000000') },
    elements,
    groups,
    notes,
  };
}

/** Length on the timeline (media: trimDuration at its speed; others: duration) */
export function clipLength(e: Record<string, any>): number {
  if (e.type === 'video' || e.type === 'audio') {
    const rate = Number(e.speed) > 4 ? Number(e.speed) / 100 : Number(e.speed) || 1;
    const span = e.trimDuration !== undefined ? Number(e.trimDuration) : Math.max(0, (Number(e.duration) || 0) - (Number(e.trimStart) || 0));
    return span / (rate || 1);
  }
  return Number(e.duration) || 0;
}
