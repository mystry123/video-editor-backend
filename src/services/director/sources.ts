// services/director/sources.ts
//
// The footage a Director run works with, and how it reads to the models.
// Sources are the project's video and audio files (S1, S2…), each with its
// MediaAnalysis. A cut is a list of spans of sources played back to back;
// `cutView` says what the edited timeline holds at each time (what is seen
// and said), so specialists can place titles, sounds and moves against it.

import type { IMediaAnalysis, MediaAnalysisResult } from '../../models/MediaAnalysis';

export interface ProjectJson {
  project: Record<string, any>;
  elements: Array<Record<string, any>>;
}

export interface Source {
  /** S1, S2… */
  ref: string;
  fileId: string;
  name: string;
  kind: 'video' | 'audio';
  url: string;
  duration: number;
  /** Picture size (0 when unknown) */
  width?: number;
  height?: number;
  /** The clip on the timeline it came from (its fields are the template for cut pieces) */
  element: Record<string, any>;
  analysis?: MediaAnalysisResult;
}

/** Other footage shown over a piece while the piece's own sound plays on (a B-roll cutaway) */
export interface Cutaway {
  /** Piece number (1-based) it covers */
  piece: number;
  /** Seconds into that piece where the picture cuts away */
  at: number;
  length: number;
  source: string;
  /** Where in that source the picture comes from */
  from: number;
}

export interface Segment {
  source: string;
  from: number;
  to: number;
  beat?: string;
  why?: string;
}

/** M:SS.s */
export const clock = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

const MEDIA = new Set(['video', 'audio']);

/** The project's video and audio files, once each, timeline order */
export function sourcesOf(project: ProjectJson): Source[] {
  const seen = new Map<string, Source>();
  const clips = [...project.elements]
    .filter((e) => MEDIA.has(e.type) && e.fileId && e.source)
    .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
  for (const e of clips) {
    const id = String(e.fileId);
    if (seen.has(id)) continue;
    seen.set(id, {
      ref: `S${seen.size + 1}`,
      fileId: id,
      name: String(e.name || 'clip'),
      kind: e.type === 'audio' ? 'audio' : 'video',
      url: String(e.source),
      duration: Number(e.sourceDuration || e.mediaDuration || 0),
      element: e,
    });
  }
  return [...seen.values()];
}

export function attachAnalyses(sources: Source[], analyses: Array<IMediaAnalysis | null>): Source[] {
  return sources.map((s, i) => {
    const a = analyses[i];
    if (!a || a.status !== 'ready') return s;
    return { ...s, analysis: a.result, duration: s.duration || a.duration };
  });
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What one source holds, for the models */
export function sourceDigest(s: Source): string {
  const a = s.analysis;
  const head = `${s.ref} "${s.name}" · ${s.kind} · ${clock(s.duration)}${a ? ` · ${a.kind}${a.language ? ` · ${a.language}` : ''}` : ''}`;
  if (!a) return `${head}\n  (not analysed: only its name and length are known)`;
  const lines = [head, `  ${cap(a.summary, 600)}`];
  if (a.shots.length) lines.push(`  Shots: ${a.shots.slice(0, 80).map((x) => `${clock(x.start)}–${clock(x.end)} ${cap(x.description, 90)}${x.framing ? ` [${x.framing}]` : ''}${x.onScreenText ? ` (text: "${cap(x.onScreenText, 40)}")` : ''}${x.enters && x.enters !== 'cut' && x.enters !== 'start' ? ` {starts with a ${x.enters} already in the footage}` : ''}`).join(' | ')}`);
  if (a.speech.length) lines.push(`  Said: ${a.speech.slice(0, 160).map((l) => `${clock(l.start)}–${clock(l.end)}${l.speaker ? ` ${l.speaker}` : ''}: "${cap(l.text, 140)}"`).join(' | ')}`);
  else lines.push('  Said: nothing (no speech)');
  if (a.moments.length) lines.push(`  Best moments: ${a.moments.slice(0, 20).map((m) => `[${m.score} ${m.kind}] ${clock(m.start)}–${clock(m.end)} ${m.title}: ${cap(m.why, 120)}`).join(' | ')}`);
  lines.push(`  Music in it: ${a.hasMusic ? 'yes' : 'no'}`);
  if (a.hasBurnedCaptions) lines.push('  Captions of the speech are already burned into the picture: do not add another set.');
  return lines.join('\n');
}

/** Segments placed back to back from 0: where each lands on the new timeline */
export function placeSegments(segments: Segment[]): Array<Segment & { at: number; length: number }> {
  let at = 0;
  return segments.map((s) => {
    const length = Math.max(0, s.to - s.from);
    const placed = { ...s, at, length };
    at += length;
    return placed;
  });
}

/** The edited timeline in words: each piece with what is seen and said, in new-timeline times */
export function cutView(segments: Segment[], sources: Source[], cutaways: Cutaway[] = []): string {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  return placeSegments(segments)
    .map((p, i) => {
      const src = byRef.get(p.source);
      const a = src?.analysis;
      const shift = (t: number) => clock(p.at + (t - p.from));
      const seen = a?.shots.filter((x) => x.end > p.from && x.start < p.to).map((x) => cap(x.description, 80)) ?? [];
      const onScreen = [...new Set(a?.shots.filter((x) => x.end > p.from && x.start < p.to && x.onScreenText).map((x) => cap(String(x.onScreenText), 60)) ?? [])];
      const said =
        a?.speech
          .filter((l) => l.end > p.from + 0.1 && l.start < p.to - 0.1)
          .map((l) => `${shift(Math.max(l.start, p.from))} "${cap(l.text, 120)}"`) ?? [];
      const over = cutaways
        .filter((c) => c.piece === i + 1)
        .map((c) => {
          const shot = byRef.get(c.source)?.analysis?.shots.find((x) => x.end > c.from && x.start <= c.from);
          return `\n    picture cuts away ${clock(p.at + c.at)}–${clock(p.at + c.at + c.length)} to ${c.source} ${clock(c.from)}${shot ? ` (${cap(shot.description, 70)})` : ''} while the sound plays on`;
        })
        .join('');
      const burned = src?.analysis?.hasBurnedCaptions ? '\n    captions of the speech are already burned into this footage' : '';
      return `#${i + 1} ${clock(p.at)}–${clock(p.at + p.length)} (${p.length.toFixed(1)}s) from ${p.source} ${clock(p.from)}–${clock(p.to)}${p.beat ? ` · ${p.beat}` : ''}\n    seen: ${seen.join('; ') || '—'}\n    said: ${said.join(' ') || '—'}${onScreen.length ? `\n    text already in the picture: ${onScreen.map((t) => `"${t}"`).join('; ')}` : ''}${burned}${over}`;
    })
    .join('\n');
}

/**
 * Pieces never end in the middle of something said: an end inside a
 * sentence moves out to the sentence's end (up to 1 s), else back to the end
 * of the sentence before. (A cut ended on "the Pyramids in" without
 * "Egypt".) Starts are left as chosen: moving them back made edits long and
 * brought back slow openings.
 */
export function snapToSpeech(segments: Segment[], sources: Source[]): Segment[] {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const MAX_STRETCH = 1;
  return segments.map((seg) => {
    const lines = byRef.get(seg.source)?.analysis?.speech ?? [];
    const { from } = seg;
    let { to } = seg;
    const endIn = lines.find((l) => to > l.start + 0.15 && to < l.end - 0.1);
    if (endIn) {
      const duration = byRef.get(seg.source)?.duration || Infinity;
      if (endIn.end - to <= MAX_STRETCH && endIn.end + 0.15 <= duration) to = endIn.end + 0.15;
      else {
        const before = lines.filter((l) => l.end <= endIn.start + 0.05 && l.end > from + 0.4).pop();
        if (before) to = before.end + 0.1;
      }
    }
    return { ...seg, to: Math.round(to * 100) / 100 };
  });
}

/** Problems with a cut a model must fix (outside its source, too short, unknown source) */
export function cutProblems(segments: Segment[], sources: Source[], targetSeconds?: number, cutaways: Cutaway[] = []): string[] {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const problems: string[] = [];
  if (!segments.length) problems.push('The cut has no pieces.');
  segments.forEach((s, i) => {
    const src = byRef.get(s.source);
    if (!src) return problems.push(`Piece #${i + 1}: there is no source ${s.source}.`);
    if (!(s.to > s.from)) problems.push(`Piece #${i + 1}: it ends (${clock(s.to)}) before it starts (${clock(s.from)}).`);
    else if (s.to - s.from < 0.4) problems.push(`Piece #${i + 1}: ${(s.to - s.from).toFixed(2)}s is too short to read; make it at least 0.4s.`);
    if (s.from < 0 || (src.duration && s.to > src.duration + 0.05)) problems.push(`Piece #${i + 1}: ${clock(s.from)}–${clock(s.to)} is outside ${s.source} (0:00–${clock(src.duration)}).`);
  });
  cutaways.forEach((c, i) => {
    const piece = segments[c.piece - 1];
    const src = byRef.get(c.source);
    if (!piece) return problems.push(`Cutaway ${i + 1}: there is no piece #${c.piece}.`);
    if (!src) return problems.push(`Cutaway ${i + 1}: there is no source ${c.source}.`);
    if (src.kind !== 'video') problems.push(`Cutaway ${i + 1}: ${c.source} has no picture.`);
    if (c.at < 0 || c.length < 0.4 || c.at + c.length > piece.to - piece.from + 0.05) problems.push(`Cutaway ${i + 1}: ${c.at.toFixed(1)}s + ${c.length.toFixed(1)}s doesn't fit inside piece #${c.piece} (${(piece.to - piece.from).toFixed(1)}s).`);
    if (c.from < 0 || (src.duration && c.from + c.length > src.duration + 0.05)) problems.push(`Cutaway ${i + 1}: ${clock(c.from)} + ${c.length.toFixed(1)}s is outside ${c.source}.`);
  });
  const total = segments.reduce((t, s) => t + Math.max(0, s.to - s.from), 0);
  if (targetSeconds && Math.abs(total - targetSeconds) > Math.max(1, targetSeconds * 0.1)) {
    problems.push(`The cut is ${total.toFixed(1)}s long; the brief asks for ${targetSeconds}s (±${Math.max(1, targetSeconds * 0.1).toFixed(1)}s).`);
  }
  return problems;
}
