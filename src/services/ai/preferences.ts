// services/ai/preferences.ts
//
// Cue's detailed preferences: how this user wants their videos to look and
// sound. Every field is optional; they go into Cue's instructions as plain
// sentences. Free-form notes ("remember…") are kept separately (memory).

import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const text = (max: number) => z.string().trim().max(max);

export const PREFERENCE_CHOICES = {
  captionStyle: ['bold-highlight', 'clean', 'big-punchy', 'karaoke', 'none'],
  captionPosition: ['top', 'middle', 'bottom'],
  defaultFormat: ['9:16', '16:9', '1:1', '4:5'],
  tone: ['energetic', 'calm', 'professional', 'playful', 'inspiring'],
  pacing: ['fast', 'balanced', 'slow'],
  animationStyle: ['snappy', 'smooth', 'minimal'],
} as const;

export const preferencesSchema = z
  .object({
    brandName: text(60),
    about: text(500),
    brandColors: z.array(hex).max(5),
    titleFont: text(80),
    bodyFont: text(80),
    captionStyle: z.enum(PREFERENCE_CHOICES.captionStyle),
    captionPosition: z.enum(PREFERENCE_CHOICES.captionPosition),
    defaultFormat: z.enum(PREFERENCE_CHOICES.defaultFormat),
    tone: z.enum(PREFERENCE_CHOICES.tone),
    pacing: z.enum(PREFERENCE_CHOICES.pacing),
    animationStyle: z.enum(PREFERENCE_CHOICES.animationStyle),
    language: text(40),
    avoid: text(500),
  })
  .partial()
  .strict();

export type Preferences = z.infer<typeof preferencesSchema>;

/** Drops empty values so "cleared" fields disappear */
export function cleanPreferences(prefs: Preferences): Preferences {
  return Object.fromEntries(
    Object.entries(prefs).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== ''))
  ) as Preferences;
}

const CAPTION_STYLE: Record<string, string> = {
  'bold-highlight': 'bold, with the spoken word highlighted',
  clean: 'clean and minimal',
  'big-punchy': 'big and punchy, a few words at a time',
  karaoke: 'karaoke style, words lighting up as they are said',
  none: 'no captions unless asked',
};

/** The preferences as sentences for Cue's instructions ('' if none) */
export function describePreferences(prefs: Preferences | undefined): string[] {
  if (!prefs) return [];
  const p = prefs;
  const out: string[] = [];
  if (p.brandName) out.push(`Brand or channel: ${p.brandName}.`);
  if (p.about) out.push(`What their videos are about / audience: ${p.about}`);
  if (p.brandColors?.length) out.push(`Brand colours: ${p.brandColors.join(', ')} (use them for text, highlights and shapes).`);
  if (p.titleFont) out.push(`Titles use the font ${p.titleFont}.`);
  if (p.bodyFont) out.push(`Other text and captions use the font ${p.bodyFont}.`);
  if (p.captionStyle) out.push(`Captions: ${CAPTION_STYLE[p.captionStyle]}${p.captionPosition ? `, at the ${p.captionPosition} of the frame` : ''}.`);
  else if (p.captionPosition) out.push(`Captions sit at the ${p.captionPosition} of the frame.`);
  if (p.defaultFormat) out.push(`Their usual format is ${p.defaultFormat}.`);
  if (p.tone) out.push(`Tone: ${p.tone} (for text, voiceovers, music and sound choices).`);
  if (p.pacing) out.push(`Pacing: ${p.pacing === 'fast' ? 'fast, short cuts' : p.pacing === 'slow' ? 'slow and calm' : 'balanced'}.`);
  if (p.animationStyle) out.push(`Animation style: ${p.animationStyle}.`);
  if (p.language) out.push(`Write text and voiceovers in ${p.language} unless asked otherwise.`);
  if (p.avoid) out.push(`Avoid: ${p.avoid}`);
  return out;
}
