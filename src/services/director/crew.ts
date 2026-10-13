// services/director/crew.ts
//
// Cue Director's crew. The director (strongest model, thinking hard) reads
// the request and the footage and writes a creative brief; specialists each
// make one part of the edit against it: the story editor picks and orders the
// pieces of footage, then the typographer (titles, captions), motion designer
// (moves, transitions), sound designer and asset scout work in parallel on
// the cut. Every answer is JSON in a fixed vocabulary; compile.ts turns it
// into timeline elements, so the models make creative choices and code keeps
// the project valid. `notes` carry the director's review back to a specialist.

import { env } from '../../config/env';
import { getGeminiClient } from '../ai/gemini';
import { clock, cutView, sourceDigest, type Cutaway, type Segment, type Source } from './sources';

// ---------------------------------------------------------------------------
// Vocabulary (compile.ts maps each word to real editor settings)
// ---------------------------------------------------------------------------

export const ASPECTS = ['9:16', '1:1', '4:5', '16:9', 'keep'] as const;
export const POSITIONS = ['top', 'upper', 'center', 'lower', 'bottom'] as const;
export const TITLE_STYLES = ['bold', 'boxed', 'outline', 'minimal', 'highlight'] as const;
export const TEXT_MOTIONS = ['pop', 'slide-up', 'fade', 'zoom', 'typewriter', 'word-by-word', 'none'] as const;
export const CAPTION_STYLES = ['word-pop', 'karaoke', 'clean', 'bold-box'] as const;
export const MOVES = ['none', 'punch-in', 'slow-zoom-in', 'slow-zoom-out', 'pan-left', 'pan-right', 'shake', 'zoom-out-reveal'] as const;
export const TRANSITIONS = ['cut', 'crossfade', 'whip', 'zoom', 'flash', 'slide', 'glitch', 'blur'] as const;
export const SFX_KINDS = ['whoosh', 'pop', 'riser', 'hit', 'click', 'ding', 'swoosh', 'camera-shutter', 'record-scratch'] as const;
export const ASSET_KINDS = ['stock-video', 'stock-photo', 'ai-image'] as const;

export interface Brief {
  understood: string;
  platform: string;
  aspect: (typeof ASPECTS)[number];
  targetSeconds: number;
  tone: string;
  audience: string;
  hook: string;
  structure: Array<{ beat: string; seconds: number; intent: string }>;
  story: string;
  type: string;
  captions: { use: boolean; style: (typeof CAPTION_STYLES)[number]; why: string };
  motion: string;
  sound: string;
  assets: string;
  /** Leave the project's other layers (titles, stickers…) as they are */
  keepOtherLayers: boolean;
}

export interface Cut {
  segments: Segment[];
  cutaways: Cutaway[];
  notes: string;
}

export interface TypePart {
  titles: Array<{ text: string; start: number; end: number; role: string; position: (typeof POSITIONS)[number]; style: (typeof TITLE_STYLES)[number]; motion: (typeof TEXT_MOTIONS)[number]; color?: string; accent?: string }>;
  captions: { use: boolean; style: (typeof CAPTION_STYLES)[number]; position: (typeof POSITIONS)[number]; highlightColor?: string };
  notes: string;
}

export interface MotionPart {
  pieces: Array<{ piece: number; move: (typeof MOVES)[number]; transitionIn: (typeof TRANSITIONS)[number]; why?: string }>;
  notes: string;
}

export interface SoundPart {
  originalAudio: 'keep' | 'lower' | 'mute';
  sfx: Array<{ at: number; kind: (typeof SFX_KINDS)[number]; why?: string }>;
  music: { use: boolean; mood: string; prompt: string };
  notes: string;
}

export interface AssetPart {
  assets: Array<{ start: number; end: number; kind: (typeof ASSET_KINDS)[number]; query: string; placement: 'fullscreen' | 'overlay'; why: string }>;
  notes: string;
}

// ---------------------------------------------------------------------------

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'STRING', description, ...extra });
const N = (description: string) => ({ type: 'NUMBER', description });
const E = (values: readonly string[], description = '') => ({ type: 'STRING', enum: [...values], ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'OBJECT', properties, required });
const arr = (items: unknown, description = '') => ({ type: 'ARRAY', items, ...(description ? { description } : {}) });

const CRAFT = `Craft rules for short social edits (follow them unless the brief says otherwise):
- The first 1–2 seconds decide everything: open on the strongest line or image, never on a slow intro, greeting or logo.
- Something new every 2–3 seconds (a cut, a move, a title, a sound) so attention never drops; vary it.
- Cut on sentence or phrase boundaries: never cut a word in half, never end a piece mid-thought.
- One idea per beat. Payoff near the end, then a crisp ending (a reveal, a punchline, or a short call to action) — no fade to black limbo.
- Text is short (2–6 words per title), big, high contrast, inside the safe area (not the top 12% or bottom 18% on 9:16, where app buttons sit).
- Sound sells cuts: a whoosh into a transition, a pop on a title, a hit on the payoff — sparingly, never on every cut.`;

async function ask<T>(opts: { model: string; system: string; text: string; schema: Record<string, unknown>; thinking: 'low' | 'high'; timeoutMs?: number }): Promise<T> {
  const result = await getGeminiClient().generate({
    model: opts.model,
    fallback: opts.model === env.directorModel ? env.aiModelStrong : env.aiModelFallback,
    system: opts.system,
    messages: [{ role: 'user', text: opts.text }],
    jsonSchema: opts.schema,
    thinking: opts.thinking,
    // Specialists answer in seconds; a stuck call moves on to the fallback quickly
    timeoutMs: opts.timeoutMs ?? (opts.model === env.directorModel ? 120_000 : 60_000),
  });
  return result.json as T;
}

const footage = (sources: Source[]) => sources.map(sourceDigest).join('\n\n') || '(no video or audio in the project)';

// ---------------------------------------------------------------------------
// Director: the brief
// ---------------------------------------------------------------------------

const BRIEF_SCHEMA = obj({
  understood: S('One sentence: what the user wants, in your words'),
  platform: S('Where it will be posted (Instagram Reels, YouTube Shorts, TikTok, YouTube, LinkedIn, …)'),
  aspect: E(ASPECTS, 'Frame shape for that platform; keep = leave as is'),
  targetSeconds: N('Length of the finished edit in seconds'),
  tone: S('The feel: e.g. energetic and playful, calm and cinematic'),
  audience: S('Who it is for'),
  hook: S('The opening 1–2 seconds: exactly which moment or line from the footage, and why it stops the scroll'),
  structure: arr(obj({ beat: S('hook, setup, highlight, payoff, call to action…'), seconds: N('about how long'), intent: S('what this beat does, with the footage moment it should use') }), 'The beats in order; seconds add up to targetSeconds'),
  story: S('Notes for the story editor: which moments to use, what to leave out, pacing'),
  type: S('Notes for the typographer: title wording ideas, where text helps, the look'),
  captions: obj({ use: { type: 'BOOLEAN' }, style: E(CAPTION_STYLES), why: S('why') }),
  motion: S('Notes for the motion designer: energy of moves and transitions'),
  sound: S('Notes for the sound designer: sound effects, music, keep or lower the original sound'),
  assets: S('Notes for the asset scout: B-roll, photos or AI images worth adding, or "none"'),
  keepOtherLayers: { type: 'BOOLEAN', description: 'Keep the project\'s existing titles, stickers and overlays (true) or replace them with the new edit (false)' },
});

export async function writeBrief(input: { request: string; conversation: string; project: string; sources: Source[]; preferences: string; notes?: string }): Promise<Brief> {
  const system = `You are the director of a world-class short-form video studio. You turn raw footage into edits people watch to the end and share.
Read the request, the conversation and the logged footage, then write the creative brief your crew will follow. Be specific to THIS footage: name the exact moments (with times) and lines that make the edit. Never write generic advice.
If the user names a length, platform or style, that wins. Otherwise choose what suits the request (a "reel" is 9:16 for Instagram, 15–30 s).

${CRAFT}`;
  const text = `REQUEST\n${input.request}\n\nRECENT CONVERSATION\n${input.conversation || '(none)'}\n\nPROJECT NOW\n${input.project}\n\nFOOTAGE (logged)\n${footage(input.sources)}${input.preferences ? `\n\nTHE USER'S PREFERENCES\n${input.preferences}` : ''}${input.notes ? `\n\nNOTES FROM YOUR REVIEW OF THE LAST DRAFT\n${input.notes}` : ''}`;
  const brief = await ask<Brief>({ model: env.directorModel, system, text, schema: BRIEF_SCHEMA, thinking: 'high' });
  brief.targetSeconds = Math.max(3, Math.min(600, Number(brief.targetSeconds) || 30));
  return brief;
}

// ---------------------------------------------------------------------------
// Story editor: the cut
// ---------------------------------------------------------------------------

const CUT_SCHEMA = obj({
  segments: arr(
    obj({
      source: S('S1, S2…'),
      from: S('Start in the source, M:SS.s'),
      to: S('End in the source, M:SS.s'),
      beat: S('Which beat of the brief'),
      why: S('Why this piece, in a few words'),
    }),
    'The pieces in playing order'
  ),
  cutaways: arr(
    obj({
      piece: { type: 'INTEGER', description: 'Piece number (#1…) whose sound keeps playing' },
      at: N('Seconds into that piece where the picture cuts away'),
      length: N('Seconds the other picture shows (fits inside the piece)'),
      source: S('S1, S2…'),
      from: S('Where in that source the picture comes from, M:SS.s'),
    }),
    'B-roll over speech: the piece\'s voice plays on while the picture shows something else (what is talked about, a scenic shot). Empty if none.'
  ),
  notes: S('One or two sentences on the choices'),
});

const time = (v: unknown) => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').trim();
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((a, p) => a * 60 + Number(p), 0);
};

export async function cutStory(input: { brief: Brief; sources: Source[]; problems?: string[]; notes?: string; previous?: Segment[]; previousCutaways?: Cutaway[] }): Promise<Cut> {
  const system = `You are the story editor. You build the cut: which spans of footage play, in what order, to hit the brief's beats and length exactly.
Use the logged shots, speech and moments; choose the strongest material. Start and end each piece on the edges of what is said (use the "Said" times) so no sentence is cut off, or on shot changes for pieces without speech. Pieces may come from anywhere in any source, in any order (a later line can open the edit as the hook).
Cutaways: while someone talks, the picture can cut away to other footage (what they talk about, a beautiful shot) and the voice plays on — the classic way to keep a talking edit visual and fast. Use them when the brief asks for voice over B-roll or when a speaking piece runs long on one face.
The pieces' lengths must add up to the brief's target length (within 10%).

${CRAFT}`;
  const fix = input.problems?.length ? `\n\nYOUR LAST CUT HAD THESE PROBLEMS — FIX THEM\n- ${input.problems.join('\n- ')}` : '';
  const prev = input.previous?.length
    ? `\n\nYOUR LAST CUT\n${input.previous.map((s, i) => `#${i + 1} ${s.source} ${clock(s.from)}–${clock(s.to)} ${s.beat ?? ''}`).join('\n')}${(input.previousCutaways ?? []).map((c) => `\ncutaway over #${c.piece} at ${c.at}s for ${c.length}s → ${c.source} ${clock(c.from)}`).join('')}`
    : '';
  const text = `BRIEF\n${JSON.stringify(input.brief, null, 1)}\n\nFOOTAGE (logged)\n${footage(input.sources)}${prev}${fix}${input.notes ? `\n\nDIRECTOR'S NOTES ON YOUR LAST CUT\n${input.notes}` : ''}`;
  const raw = await ask<{ segments: Array<Record<string, unknown>>; cutaways?: Array<Record<string, unknown>>; notes: string }>({ model: env.directorModel, system, text, schema: CUT_SCHEMA, thinking: 'high', timeoutMs: 150_000 });
  return {
    notes: String(raw.notes || ''),
    segments: (raw.segments ?? []).map((s) => ({
      source: String(s.source || '').trim().toUpperCase(),
      from: Math.round(time(s.from) * 100) / 100,
      to: Math.round(time(s.to) * 100) / 100,
      beat: s.beat ? String(s.beat) : undefined,
      why: s.why ? String(s.why) : undefined,
    })),
    cutaways: (raw.cutaways ?? []).map((c) => ({
      piece: Math.round(Number(c.piece)),
      at: Math.round(Number(c.at) * 100) / 100,
      length: Math.round(Number(c.length) * 100) / 100,
      source: String(c.source || '').trim().toUpperCase(),
      from: Math.round(time(c.from) * 100) / 100,
    })).filter((c) => Number.isFinite(c.piece) && Number.isFinite(c.at) && Number.isFinite(c.length) && Number.isFinite(c.from)),
  };
}

// ---------------------------------------------------------------------------
// Specialists on the cut (in parallel)
// ---------------------------------------------------------------------------

interface OnCut {
  brief: Brief;
  segments: Segment[];
  cutaways?: Cutaway[];
  sources: Source[];
  frame: { width: number; height: number };
  notes?: string;
}

const cutText = (input: OnCut) => {
  const total = input.segments.reduce((t, s) => t + (s.to - s.from), 0);
  return `BRIEF\n${JSON.stringify(input.brief, null, 1)}\n\nTHE CUT (new timeline, ${total.toFixed(1)}s, frame ${input.frame.width}×${input.frame.height})\n${cutView(input.segments, input.sources, input.cutaways)}${
    input.notes ? `\n\nDIRECTOR'S NOTES ON YOUR LAST PASS\n${input.notes}` : ''
  }\n\nTimes you give are seconds on the NEW timeline (0 = start of the edit).`;
};

const TYPE_SCHEMA = obj({
  titles: arr(
    obj(
      {
        text: S('2–6 words; may use line breaks'),
        start: N('seconds'),
        end: N('seconds'),
        role: S('hook, label, punchline, call-to-action…'),
        position: E(POSITIONS),
        style: E(TITLE_STYLES),
        motion: E(TEXT_MOTIONS, 'How it comes in'),
        color: S('Text colour as #RRGGBB'),
        accent: S('Box or highlight colour as #RRGGBB'),
      },
      ['text', 'start', 'end', 'role', 'position', 'style', 'motion']
    ),
    'On-screen titles; none is fine when captions carry it'
  ),
  captions: obj({ use: { type: 'BOOLEAN' }, style: E(CAPTION_STYLES), position: E(POSITIONS), highlightColor: S('#RRGGBB for the spoken word') }, ['use', 'style', 'position']),
  notes: S('One sentence'),
});

export async function designType(input: OnCut): Promise<TypePart> {
  const system = `You are the typographer and caption designer. Add the on-screen words that make the edit land: a hook title in the first second when it helps, labels or punchlines that add what the picture can't, a call to action if the brief wants one. If the footage already shows captions or subtitles of the speech (see "text already in the picture"), do NOT add captions (captions.use = false): two sets of captions look broken. Never repeat captions word for word in a title. Never cover faces or important on-screen text (check what is seen). Keep titles clear of captions (different positions).
${CRAFT}`;
  return ask<TypePart>({ model: env.directorWorkerModel, system, text: cutText(input), schema: TYPE_SCHEMA, thinking: 'low' });
}

const MOTION_SCHEMA = obj({
  pieces: arr(obj({ piece: { type: 'INTEGER', description: 'Piece number (#1…)' }, move: E(MOVES), transitionIn: E(TRANSITIONS, 'How this piece comes in (cut for #1)'), why: S('few words') }, ['piece', 'move', 'transitionIn'])),
  notes: S('One sentence'),
});

export async function designMotion(input: OnCut): Promise<MotionPart> {
  const system = `You are the motion designer. For each piece of the cut choose a camera move and how it comes in. Moves add energy and hide jump cuts (punch-in on a strong line, slow zoom on scenery, shake on an impact). Most pieces in a punchy edit come in on a straight cut; save stylised transitions (whip, zoom, flash, glitch) for beat changes, at most one in three. Static is fine for a piece that needs to breathe.
${CRAFT}`;
  return ask<MotionPart>({ model: env.directorWorkerModel, system, text: cutText(input), schema: MOTION_SCHEMA, thinking: 'low' });
}

const SOUND_SCHEMA = obj({
  originalAudio: E(['keep', 'lower', 'mute'], 'The footage\'s own sound: keep (speech matters), lower (under music), mute'),
  sfx: arr(obj({ at: N('seconds'), kind: E(SFX_KINDS), why: S('few words') }, ['at', 'kind']), 'At most one every 2 seconds; usually 2–6 in total'),
  music: obj({ use: { type: 'BOOLEAN' }, mood: S('e.g. upbeat travel pop, tense cinematic'), prompt: S('A short description to generate it: genre, tempo, instruments, mood; no artist names') }),
  notes: S('One sentence'),
});

export async function designSound(input: OnCut): Promise<SoundPart> {
  const system = `You are the sound designer. Decide what happens to the footage's own sound, which sound effects punctuate the edit and whether music runs under it. Speech must always stay clear: if people talk, keep their sound and keep music low. Sound effects go on transitions, title entrances and the payoff, never on every cut.
${CRAFT}`;
  return ask<SoundPart>({ model: env.directorWorkerModel, system, text: cutText(input), schema: SOUND_SCHEMA, thinking: 'low' });
}

const ASSET_SCHEMA = obj({
  assets: arr(
    obj({
      start: N('seconds'),
      end: N('seconds'),
      kind: E(ASSET_KINDS),
      query: S('Stock search words (stock-*) or a full image description (ai-image)'),
      placement: E(['fullscreen', 'overlay']),
      why: S('What it adds that the footage lacks'),
    }),
    'Usually none to three. Only when it clearly adds something'
  ),
  notes: S('One sentence'),
});

export async function scoutAssets(input: OnCut): Promise<AssetPart> {
  const system = `You are the asset scout. Suggest outside pictures only where the footage lacks something the story needs (an establishing shot, an illustration of what is said). The user's own footage is almost always better than stock: prefer none. Never cover a speaker's key line with stock.
${CRAFT}`;
  return ask<AssetPart>({ model: env.directorWorkerModel, system, text: cutText(input), schema: ASSET_SCHEMA, thinking: 'low' });
}
