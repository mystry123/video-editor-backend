// services/ai/editorTools.ts
//
// What the assistant can do in the editor, as Gemini function declarations,
// and a strict check of every call it makes. The model never changes a
// project: it proposes these calls, the editor turns them into a changeset
// the user reviews, and only Apply changes anything. Lists that depend on the
// editor (animation and transition ids, fonts) come with each request as
// `capabilities`, so the model can only pick what Shotline really has.
//
// Units: times in seconds (project time unless said otherwise); positions in
// % of the frame (x/y = the clip's centre); sizes in px at the project's size.

import { z } from 'zod';
import type { GeminiTool } from './gemini';

export interface AssistantCapabilities {
  animations?: { in?: string[]; out?: string[]; loop?: string[] };
  transitions?: string[];
  fonts?: string[];
  dubLanguages?: string[];
}

const KEYFRAME_PROPERTIES = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const;
const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const id = z.string().min(1).max(40);
const seconds = num(0, 4 * 3600);

/** Vertex schema helpers (OpenAPI subset) */
const S = {
  str: (description: string, extra: Record<string, unknown> = {}) => ({ type: 'STRING', description, ...extra }),
  num: (description: string) => ({ type: 'NUMBER', description }),
  bool: (description: string) => ({ type: 'BOOLEAN', description }),
  enum: (description: string, values: readonly string[]) => ({ type: 'STRING', description, enum: [...values] }),
  arr: (description: string, items: Record<string, unknown>) => ({ type: 'ARRAY', description, items }),
  obj: (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'OBJECT', properties, required }),
};

interface ToolDef {
  description: string;
  parameters: (caps: AssistantCapabilities) => Record<string, unknown>;
  args: (caps: AssistantCapabilities) => z.ZodTypeAny;
}

const textStyleProps = (caps: AssistantCapabilities) => ({
  font_size: S.num('Font size in px at the project size'),
  color: S.str('Text colour, #RRGGBB'),
  font_family: caps.fonts?.length ? S.enum('Font', caps.fonts) : S.str('Font family'),
  font_weight: S.num('100–900'),
  background_color: S.str('Box behind the text, #RRGGBB (omit for none)'),
});

const textStyleArgs = (caps: AssistantCapabilities) => ({
  font_size: num(4, 1000).optional(),
  color: z.string().regex(HEX).optional(),
  font_family: (caps.fonts?.length ? z.enum(caps.fonts as [string, ...string[]]) : z.string().max(80)).optional(),
  font_weight: num(100, 900).optional(),
  background_color: z.string().regex(HEX).optional(),
});

export const EDITOR_TOOLS: Record<string, ToolDef> = {
  add_text: {
    description: 'Add a text clip (title, label, call to action).',
    parameters: (caps) =>
      S.obj(
        {
          text: S.str('The text'),
          start: S.num('When it appears, seconds'),
          duration: S.num('How long it shows, seconds'),
          position: S.enum('Where on screen (ignored if x/y given)', ['top', 'center', 'bottom']),
          x: S.num('Centre x, % of frame width'),
          y: S.num('Centre y, % of frame height'),
          ...textStyleProps(caps),
        },
        ['text', 'start', 'duration']
      ),
    args: (caps) =>
      z.object({
        text: z.string().min(1).max(500),
        start: seconds,
        duration: num(0.1, 4 * 3600),
        position: z.enum(['top', 'center', 'bottom']).optional(),
        x: num(-50, 150).optional(),
        y: num(-50, 150).optional(),
        ...textStyleArgs(caps),
      }),
  },
  update_clip: {
    description: 'Change a clip: timing, position, size, opacity, rotation, volume, mute, text and text style. Only send what changes.',
    parameters: (caps) =>
      S.obj(
        {
          id: S.str('Clip id from the project summary (c1, c2…)'),
          start: S.num('New start, seconds'),
          duration: S.num('New length, seconds'),
          x: S.num('Centre x, % of frame width'),
          y: S.num('Centre y, % of frame height'),
          width: S.num('Width, % of frame width'),
          height: S.num('Height, % of frame height'),
          opacity: S.num('0–100'),
          rotation: S.num('Degrees'),
          volume: S.num('0–200 (100 = normal)'),
          muted: S.bool('Mute the clip'),
          text: S.str('New text (text clips)'),
          name: S.str('Clip name'),
          ...textStyleProps(caps),
        },
        ['id']
      ),
    args: (caps) =>
      z.object({
        id,
        start: seconds.optional(),
        duration: num(0.05, 4 * 3600).optional(),
        x: num(-100, 200).optional(),
        y: num(-100, 200).optional(),
        width: num(1, 500).optional(),
        height: num(1, 500).optional(),
        opacity: num(0, 100).optional(),
        rotation: num(-3600, 3600).optional(),
        volume: num(0, 200).optional(),
        muted: z.boolean().optional(),
        text: z.string().min(1).max(500).optional(),
        name: z.string().min(1).max(80).optional(),
        ...textStyleArgs(caps),
      }),
  },
  trim_clip: {
    description: 'Cut seconds off the start and/or end of a video or audio clip (the clip keeps its start time).',
    parameters: () =>
      S.obj(
        {
          id: S.str('Clip id'),
          remove_from_start: S.num('Seconds to cut from the beginning'),
          remove_from_end: S.num('Seconds to cut from the end'),
        },
        ['id']
      ),
    args: () => z.object({ id, remove_from_start: num(0, 4 * 3600).optional(), remove_from_end: num(0, 4 * 3600).optional() }),
  },
  split_clip: {
    description: 'Split a clip in two at a time.',
    parameters: () => S.obj({ id: S.str('Clip id'), at: S.num('Project time to split at, seconds') }, ['id', 'at']),
    args: () => z.object({ id, at: seconds }),
  },
  delete_clips: {
    description: 'Delete clips.',
    parameters: () => S.obj({ ids: S.arr('Clip ids', S.str('Clip id')) }, ['ids']),
    args: () => z.object({ ids: z.array(id).min(1).max(50) }),
  },
  duplicate_clip: {
    description: 'Copy a clip, optionally to a new start time.',
    parameters: () => S.obj({ id: S.str('Clip id'), start: S.num('Start of the copy, seconds') }, ['id']),
    args: () => z.object({ id, start: seconds.optional() }),
  },
  set_layer: {
    description: 'Change stacking order (what is drawn on top).',
    parameters: () => S.obj({ id: S.str('Clip id'), action: S.enum('Where', ['front', 'back', 'forward', 'backward']) }, ['id', 'action']),
    args: () => z.object({ id, action: z.enum(['front', 'back', 'forward', 'backward']) }),
  },
  set_keyframes: {
    description:
      'Animate a property with keyframes (replaces that property\'s keyframes; empty list removes them). Times are seconds from the clip\'s start. Units: x/y in % of frame, scale in % (100 = normal), rotation in degrees, opacity and volume 0–100.',
    parameters: () =>
      S.obj(
        {
          id: S.str('Clip id'),
          property: S.enum('Property', KEYFRAME_PROPERTIES),
          keyframes: S.arr(
            'Keyframes in time order',
            S.obj({ time: S.num('Seconds from clip start'), value: S.num('Value'), easing: S.enum('Easing to the next keyframe', EASINGS) }, ['time', 'value'])
          ),
        },
        ['id', 'property', 'keyframes']
      ),
    args: () =>
      z.object({
        id,
        property: z.enum(KEYFRAME_PROPERTIES),
        keyframes: z.array(z.object({ time: seconds, value: num(-100000, 100000), easing: z.enum(EASINGS).optional() })).max(30),
      }),
  },
  set_project: {
    description: 'Change the project: size (e.g. 1080×1920 for 9:16), length, background colour.',
    parameters: () =>
      S.obj({ width: S.num('px'), height: S.num('px'), duration: S.num('seconds'), background_color: S.str('#RRGGBB') }),
    args: () =>
      z.object({
        width: num(64, 7680).optional(),
        height: num(64, 7680).optional(),
        duration: num(1, 4 * 3600).optional(),
        background_color: z.string().regex(HEX).optional(),
      }),
  },
  add_voiceover: {
    description: 'Generate a voiceover from a script (text to speech) and add it at a time; word-timed captions can come with it.',
    parameters: () =>
      S.obj(
        {
          script: S.str('What the voice says'),
          at: S.num('Start, seconds (default: playhead)'),
          voice: S.str('Voice name if the user asked for one'),
          captions: S.bool('Also add captions (default true)'),
        },
        ['script']
      ),
    args: () => z.object({ script: z.string().min(1).max(5000), at: seconds.optional(), voice: z.string().max(60).optional(), captions: z.boolean().optional() }),
  },
  add_sound_effect: {
    description: 'Generate a sound effect from a description and add it at a time.',
    parameters: () =>
      S.obj({ prompt: S.str('Describe the sound'), at: S.num('Start, seconds'), duration: S.num('0.5–22 seconds (omit for automatic)') }, ['prompt', 'at']),
    args: () => z.object({ prompt: z.string().min(2).max(300), at: seconds, duration: num(0.5, 22).optional() }),
  },
  add_gif: {
    description:
      'Add an animated GIF or sticker from GIPHY found by a search query (stickers have transparent backgrounds: emojis, arrows, reactions, decorations). The user sees the match and can pick another before applying.',
    parameters: () =>
      S.obj(
        {
          query: S.str('What to search on GIPHY, a few words (e.g. "fire emoji", "mind blown", "celebration confetti")'),
          kind: S.enum('gif = rectangular clip, sticker = transparent cut-out', ['gif', 'sticker']),
          at: S.num('Start, seconds'),
          duration: S.num('How long it shows, seconds (default 3)'),
          position: S.enum('Where (default centre)', ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']),
          size: S.num('Width, % of the frame width (default 35 for stickers, 70 for GIFs)'),
        },
        ['query', 'kind', 'at']
      ),
    args: () =>
      z.object({
        query: z.string().min(1).max(80),
        kind: z.enum(['gif', 'sticker']),
        at: seconds,
        duration: num(0.2, 60).optional(),
        position: z.enum(['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
        size: num(5, 100).optional(),
      }),
  },
  propose_plan: {
    description:
      'For a big or multi-part request (e.g. "turn this into a 30s reel", "make it look like a podcast clip"), propose a short plan instead of edits. Each step is a concrete goal you will carry out with the other tools when the user runs it. Use for roughly 5+ edits or vague creative goals; otherwise edit directly.',
    parameters: () =>
      S.obj(
        {
          title: S.str('What the plan achieves, a few words'),
          steps: S.arr('2–8 steps in order, each one concrete goal', S.str('A step, e.g. "Trim the intro to start at the first sentence"')),
        },
        ['title', 'steps']
      ),
    args: () => z.object({ title: z.string().min(1).max(120), steps: z.array(z.string().min(3).max(300)).min(2).max(8) }),
  },
  remember: {
    description:
      'Save a lasting preference the user states about how they want their videos (fonts, brand colours, caption style, tone, defaults), so future edits follow it. Only for preferences, not one-off edits.',
    parameters: () => S.obj({ note: S.str('The preference, short and specific, e.g. "Titles use Poppins Bold, white"') }, ['note']),
    args: () => z.object({ note: z.string().min(3).max(300) }),
  },
  add_captions: {
    description: 'Add word-timed captions for a video or audio clip (transcribes it).',
    parameters: () => S.obj({ id: S.str('Video or audio clip id') }, ['id']),
    args: () => z.object({ id }),
  },
  clean_audio: {
    description: "Remove background noise from a clip's sound (the original is kept, muted).",
    parameters: () => S.obj({ id: S.str('Video or audio clip id') }, ['id']),
    args: () => z.object({ id }),
  },
  dub_clip: {
    description: "Dub a clip's speech into another language (the original is kept, muted).",
    parameters: (caps) =>
      S.obj(
        { id: S.str('Video or audio clip id'), language: caps.dubLanguages?.length ? S.enum('Language code', caps.dubLanguages) : S.str('ISO 639-1 language code') },
        ['id', 'language']
      ),
    args: (caps) => z.object({ id, language: caps.dubLanguages?.length ? z.enum(caps.dubLanguages as [string, ...string[]]) : z.string().regex(/^[a-z]{2}$/) }),
  },
};

/** Animation and transition tools exist only when the editor sends what it has. */
function animationTools(caps: AssistantCapabilities): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const slots = (['in', 'out', 'loop'] as const).filter((slot) => caps.animations?.[slot]?.length);
  if (slots.length) {
    const presets = [...new Set(slots.flatMap((slot) => caps.animations![slot]!))];
    tools.set_animation = {
      description: `Give a clip a preset animation: "in" when it appears, "out" when it leaves${slots.includes('loop') ? ', "loop" while on screen' : ''}. Use "none" to remove. Presets per slot: ${slots
        .map((slot) => `${slot}: ${caps.animations![slot]!.join(', ')}`)
        .join('; ')}.`,
      parameters: () =>
        S.obj(
          { id: S.str('Clip id'), slot: S.enum('Slot', slots), preset: S.enum('Preset', ['none', ...presets]), duration: S.num('Seconds') },
          ['id', 'slot', 'preset']
        ),
      args: () =>
        z
          .object({ id, slot: z.enum(slots as unknown as [string, ...string[]]), preset: z.enum(['none', ...presets] as [string, ...string[]]), duration: num(0.05, 30).optional() })
          .refine((a) => a.preset === 'none' || caps.animations![a.slot as 'in']!.includes(a.preset), { message: 'That preset is not available for that slot' }),
    };
  }
  if (caps.transitions?.length) {
    tools.set_transition = {
      description: `Add a transition into a clip from the clip before it on the same track ("none" removes it). Transitions: ${caps.transitions.join(', ')}.`,
      parameters: () =>
        S.obj({ id: S.str('The later clip (the one transitioned into)'), preset: S.enum('Transition', ['none', ...caps.transitions!]), duration: S.num('Seconds') }, ['id', 'preset']),
      args: () => z.object({ id, preset: z.enum(['none', ...caps.transitions!] as [string, ...string[]]), duration: num(0.05, 10).optional() }),
    };
  }
  return tools;
}

function allTools(caps: AssistantCapabilities): Record<string, ToolDef> {
  return { ...EDITOR_TOOLS, ...animationTools(caps) };
}

/** The tools as Gemini function declarations. */
/** The tools as Gemini function declarations (minus `exclude`). */
export function toolDeclarations(caps: AssistantCapabilities, exclude: string[] = []): GeminiTool[] {
  return Object.entries(allTools(caps))
    .filter(([name]) => !exclude.includes(name))
    .map(([name, def]) => ({ name, description: def.description, parameters: def.parameters(caps) }));
}

export interface CheckedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Splits the model's calls into valid ones (args parsed) and problems to report back. */
export function checkCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  caps: AssistantCapabilities,
  exclude: string[] = []
): { valid: CheckedCall[]; problems: string[] } {
  const tools = Object.fromEntries(Object.entries(allTools(caps)).filter(([name]) => !exclude.includes(name)));
  const valid: CheckedCall[] = [];
  const problems: string[] = [];
  for (const call of calls) {
    const def = tools[call.name];
    if (!def) {
      problems.push(`${call.name}: there is no such tool`);
      continue;
    }
    const parsed = def.args(caps).safeParse(call.args ?? {});
    if (!parsed.success) {
      problems.push(`${call.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}`);
      continue;
    }
    valid.push({ name: call.name, args: parsed.data });
  }
  return { valid, problems };
}

export const MAX_CALLS_PER_REPLY = 40;
