// What a user may send when creating or editing a caption style (preset).
// The style itself is checked by captionStyle; everything else is bounded
// here so a user (and later the public gallery) can't store junk.

import { z } from 'zod';
import { PRESET_CATEGORIES } from '../constants/preset-categories';
import { captionStyleSchema } from './captionStyle';

const CATEGORY_IDS = ['custom', ...PRESET_CATEGORIES.map((c) => c.id)] as [string, ...string[]];

const tag = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[\p{L}\p{N} _-]+$/u, 'tags are letters, numbers, spaces, - and _');

export const createPresetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  category: z.enum(CATEGORY_IDS).optional(),
  tags: z.array(tag).max(10).optional(),
  styles: captionStyleSchema,
  isPublic: z.boolean().optional(),
  // Optional: cards are drawn from `styles` now
  previewStyles: z.record(z.unknown()).optional(),
});

export const updatePresetSchema = createPresetSchema.partial();

export const formatIssues = (error: z.ZodError) =>
  error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
