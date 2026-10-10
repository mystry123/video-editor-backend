// A caption style: the caption element fields a preset (system, saved or
// published) sets. Flat - the same field names the caption element uses -
// so applying a style is merging it onto the caption.
//
// Everything is validated here before it's stored or rendered: styles come
// from users and may be published to everyone, and the render servers draw
// them. Colours must be plain colours (no url(), which would make the
// render servers fetch it), numbers stay in range, text values are bounded,
// animation settings are plain values. Unknown keys are dropped.
//
// KEEP IN SYNC with the frontend copy:
// video-editor-frontend app/components/editor-v2/captions/captionStyleSchema.ts
// (zod 4 there, zod 3 here; same rules). Bump CAPTION_STYLE_VERSION and add
// a migration when a field changes meaning.

import { z } from 'zod';

export const CAPTION_STYLE_VERSION = 1;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgba?|hsla?)\(\s*-?[\d.]+%?\s*(?:,\s*-?[\d.]+%?\s*){2,3}\)$/i;
const NAMED = /^[a-z]{3,20}$/i;
const FONT_FAMILY = /^[\w\s'",-]{1,80}$/;
/**
 * A font the user uploaded: our upload path shape only (the backend also
 * pins the host to the media CDN when a style is saved).
 */
export const FONT_URL = /^https:\/\/[a-z0-9.-]{3,120}(?::\d{2,5})?\/(?:[\w.-]+\/)*users\/[a-f0-9]{24}\/uploads\/[0-9a-f-]{36}\.(?:woff2|woff|ttf|otf)$/i;

const color = z
  .string()
  .max(64)
  .refine((v) => HEX.test(v) || FUNCTION_COLOR.test(v) || NAMED.test(v), 'must be a plain colour (#hex, rgb(), hsl() or a name)');

const num = (min: number, max: number) => z.number().finite().min(min).max(max);

const EASINGS = [
  'linear',
  'quadratic-in', 'quadratic-out', 'quadratic-in-out',
  'cubic-in', 'cubic-out', 'cubic-in-out',
  'quartic-in', 'quartic-out', 'quartic-in-out',
  'quintic-in', 'quintic-out', 'quintic-in-out',
  'sinusoid-in', 'sinusoid-out', 'sinusoid-in-out',
  'exponential-in', 'exponential-out', 'exponential-in-out',
  'circular-in', 'circular-out', 'circular-in-out',
  'back-in', 'back-out', 'back-in-out',
  'elastic-in', 'elastic-out', 'elastic-in-out',
  'bounce-in', 'bounce-out', 'bounce-in-out',
] as const;

const WORD_ANIMATIONS = [
  'caption-word-none', 'caption-word-pop', 'caption-word-bounce', 'caption-word-slide-up',
  'caption-word-slide-down', 'caption-word-scale', 'caption-word-pulse', 'caption-word-shake',
  'caption-word-wave', 'caption-word-flip', 'caption-word-rubber-band',
] as const;

const PAGE_ANIMATIONS = [
  'caption-page-fade', 'caption-page-slide-up', 'caption-page-slide-down', 'caption-page-slide-left',
  'caption-page-slide-right', 'caption-page-scale', 'caption-page-pop', 'caption-page-bounce',
  'caption-page-flip', 'caption-page-blur',
] as const;

/** Animation settings: plain, short values only */
const animationParams = z
  .record(
    z.union([
      z.number().finite().min(-100000).max(100000),
      z.boolean(),
      z.string().max(64).refine((v) => !/url|expression|var\(|[<>"'`;{}\\]/i.test(v), 'not allowed'),
    ])
  )
  .refine((p) => Object.keys(p).length <= 30, 'too many settings');

const wordAnimation = z.object({
  type: z.enum(WORD_ANIMATIONS),
  duration: num(0, 5),
  easing: z.enum(EASINGS).optional(),
  params: animationParams.optional(),
});

const pageAnimation = z.object({
  type: z.enum(PAGE_ANIMATIONS),
  category: z.enum(['enter', 'exit']).optional(),
  duration: num(0, 5),
  easing: z.enum(EASINGS).optional(),
  params: animationParams.optional(),
});

export const captionStyleSchema = z.object({
  schemaVersion: z.literal(CAPTION_STYLE_VERSION).optional(),

  // Text
  fontFamily: z.string().regex(FONT_FAMILY, 'not a font family name').optional(),
  /** An uploaded font (fontFamily is its internal name) */
  fontUrl: z.string().max(300).regex(FONT_URL, 'must be a font you uploaded').optional(),
  fontWeight: num(100, 1000).optional(),
  fontStyle: z.enum(['normal', 'italic', 'oblique']).optional(),
  fontSize: num(0.5, 50).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  letterSpacing: num(-50, 200).optional(),
  lineHeight: num(0.5, 4).optional(),
  fillColor: color.optional(),
  fillOpacity: num(0, 1).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),

  // Word states
  highlightStyle: z.enum(['none', 'color', 'background', 'scale', 'glow', 'underline']).optional(),
  highlightColor: color.optional(),
  highlightBackgroundColor: color.optional(),
  highlightScale: num(1, 3).optional(),
  inactiveColor: color.optional(),
  inactiveOpacity: num(0, 1).optional(),
  upcomingColor: color.optional(),
  upcomingOpacity: num(0, 1).optional(),

  // Box behind the page ("" / null = none)
  backgroundColor: z.union([color, z.literal(''), z.null()]).optional(),
  backgroundXPadding: num(0, 200).optional(),
  backgroundYPadding: num(0, 200).optional(),
  backgroundBorderRadius: num(0, 500).optional(),

  // Effects
  strokeEnabled: z.boolean().optional(),
  strokeColor: color.optional(),
  strokeWidth: num(0, 50).optional(),
  strokeOpacity: num(0, 1).optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: color.optional(),
  shadowOpacity: num(0, 1).optional(),
  shadowOffsetX: num(-200, 200).optional(),
  shadowOffsetY: num(-200, 200).optional(),
  shadowBlur: num(0, 200).optional(),

  // Layout and timing
  displayMode: z.enum(['word', 'line', 'tiktok', 'karaoke', 'static']).optional(),
  wordsPerLine: num(1, 30).optional(),
  linesPerPage: num(1, 5).optional(),
  pauseSplitMs: num(0, 10000).optional(),
  leadMs: num(0, 1000).optional(),

  // Animation
  wordAnimation: wordAnimation.optional(),
  pageEnter: pageAnimation.optional(),
  pageExit: pageAnimation.optional(),
  reducedMotion: z.boolean().optional(),
});

export type CaptionStyle = z.infer<typeof captionStyleSchema>;

/** Every style field, e.g. to reset a caption before applying a style. */
export const CAPTION_STYLE_KEYS = Object.keys(captionStyleSchema.shape).filter((k) => k !== 'schemaVersion');

/**
 * Validate a style. Unknown keys are dropped; anything invalid is reported
 * (field: message), and nothing is stored.
 */
export function parseCaptionStyle(input: unknown): { ok: true; style: CaptionStyle } | { ok: false; errors: string[] } {
  const result = captionStyleSchema.safeParse(input ?? {});
  if (result.success) return { ok: true, style: { ...result.data, schemaVersion: CAPTION_STYLE_VERSION } };
  return {
    ok: false,
    errors: result.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || 'style'}: ${issue.message}`),
  };
}

/**
 * For styles already stored (presets saved before validation): keeps every
 * field that is valid on its own and drops the rest, so one bad value
 * doesn't lose the whole look.
 */
export function sanitizeStoredCaptionStyle(input: unknown): CaptionStyle {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const shape = captionStyleSchema.shape as Record<string, z.ZodTypeAny>;
  const style: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = shape[key];
    if (!field || key === 'schemaVersion') continue;
    const result = field.safeParse(value);
    if (result.success && result.data !== undefined) style[key] = result.data;
  }
  return { ...style, schemaVersion: CAPTION_STYLE_VERSION } as CaptionStyle;
}

const percent = z.string().regex(/^-?\d{1,4}(?:\.\d{1,4})?%$/, 'must be a percentage like "85%"');

/** What the captions page sends with a new caption project. */
export const captionProjectSettingsSchema = z.object({
  fontSize: num(0.5, 50).optional(),
  wordsPerLine: num(1, 30).optional(),
  linesPerPage: num(1, 5).optional(),
  position: z.enum(['top', 'bottom', 'center']).optional(),
  highlightColor: color.optional(),
  inactiveColor: color.optional(),
  upcomingColor: color.optional(),
  inactiveOpacity: num(0, 1).optional(),
  upcomingOpacity: num(0, 1).optional(),
  backgroundColor: z.union([color, z.literal('')]).optional(),
  backgroundXPadding: num(0, 200).optional(),
  backgroundYPadding: num(0, 200).optional(),
  backgroundBorderRadius: num(0, 500).optional(),
  outputFormat: z.enum(['mp4', 'webm', 'mov']).optional(),
  style: captionStyleSchema.optional(),
  placement: z.object({ x: percent.optional(), y: percent.optional(), width: percent.optional(), height: percent.optional() }).optional(),
});

/** An uploaded font must be on our media CDN (not just shaped like it). */
export function fontUrlOnCdn(style: { fontUrl?: string } | undefined, cdnUrl: string): boolean {
  if (!style?.fontUrl) return true;
  return !!cdnUrl && style.fontUrl.startsWith(`${cdnUrl.replace(/\/+$/, '')}/`);
}
