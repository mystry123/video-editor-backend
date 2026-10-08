// config/quotaFields.ts
//
// Describes every plan limit: how to label it, what unit it's in, and what
// values are valid. The admin API validates plan edits and per-user overrides
// against this, and the settings UI renders its editors and usage meters from
// it, so a new limit only needs to be added here and in UserQuota.

import { z } from 'zod';
import type { UserQuota } from './quotas';

export const RESOLUTION_TIERS = ['720p', '1080p', '4k'] as const;

export type QuotaFieldType =
  | 'count'        // whole number, -1 = unlimited
  | 'minutes'      // whole or fractional minutes, -1 = unlimited
  | 'seconds'      // whole seconds, -1 = unlimited
  | 'bytes'        // whole bytes, -1 = unlimited
  | 'boolean'
  | 'resolution'   // one tier
  | 'resolutions'  // list of tiers
  | 'policy';      // over-resolution policy

export type QuotaFieldGroup = 'rendering' | 'storage' | 'captions' | 'features';

export interface QuotaFieldDef {
  key: keyof UserQuota;
  label: string;
  description: string;
  type: QuotaFieldType;
  group: QuotaFieldGroup;
}

export const QUOTA_FIELD_GROUPS: Record<QuotaFieldGroup, string> = {
  rendering: 'Rendering',
  storage: 'Storage & uploads',
  captions: 'Transcription & captions',
  features: 'Features',
};

export const QUOTA_FIELDS: QuotaFieldDef[] = [
  { key: 'maxRenderMinutes', label: 'Render minutes', description: 'Video minutes rendered per month.', type: 'minutes', group: 'rendering' },
  { key: 'maxResolution', label: 'Max export resolution', description: 'Highest resolution a render can come out at.', type: 'resolution', group: 'rendering' },
  { key: 'overResolution', label: 'Above max resolution', description: 'Downscale the render to the maximum, or block it.', type: 'policy', group: 'rendering' },
  { key: 'priorityRendering', label: 'Priority rendering', description: 'Renders jump ahead in the queue.', type: 'boolean', group: 'rendering' },
  { key: 'watermarkFree', label: 'No watermark', description: 'Exports have no Shotline watermark.', type: 'boolean', group: 'rendering' },

  { key: 'maxStorage', label: 'Storage', description: 'Total size of uploaded media.', type: 'bytes', group: 'storage' },
  { key: 'maxVideoUploadSize', label: 'Max upload size', description: 'Largest single video file.', type: 'bytes', group: 'storage' },
  { key: 'maxReframeSeconds', label: 'Max reframe length', description: 'Longest video AI reframe can analyze.', type: 'seconds', group: 'features' },
  { key: 'maxVideoDuration', label: 'Max video length', description: 'Longest video that can be captioned.', type: 'seconds', group: 'storage' },
  { key: 'maxTemplates', label: 'Projects', description: 'Number of saved projects.', type: 'count', group: 'storage' },

  { key: 'maxTranscriptionMinutes', label: 'Transcription minutes', description: 'Audio minutes transcribed per month.', type: 'minutes', group: 'captions' },
  { key: 'maxCaptionRenderMinutes', label: 'Caption render minutes', description: 'Captioned video minutes rendered per month.', type: 'minutes', group: 'captions' },
  { key: 'maxCaptionExports', label: 'Caption exports', description: 'Captioned videos exported per month.', type: 'count', group: 'captions' },
  { key: 'maxCaptionProjects', label: 'Active caption projects', description: 'Caption projects processing at the same time.', type: 'count', group: 'captions' },
  { key: 'allowedCaptionResolutions', label: 'Caption resolutions', description: 'Resolutions captioned videos can export at.', type: 'resolutions', group: 'captions' },

  { key: 'customPresetsAllowed', label: 'Custom caption styles', description: 'Can create their own caption presets.', type: 'boolean', group: 'features' },
  { key: 'maxCustomPresets', label: 'Custom caption style limit', description: 'Number of custom caption presets.', type: 'count', group: 'features' },
];

const FIELD_BY_KEY = new Map(QUOTA_FIELDS.map((f) => [f.key as string, f]));

export function getQuotaField(key: string): QuotaFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

const unlimitedOr = (schema: z.ZodNumber) => z.union([z.literal(-1), schema]);

const VALUE_SCHEMAS: Record<QuotaFieldType, z.ZodTypeAny> = {
  count: unlimitedOr(z.number().int().min(0).max(1_000_000)),
  minutes: unlimitedOr(z.number().min(0).max(1_000_000)),
  seconds: unlimitedOr(z.number().int().min(0).max(1_000_000_000)),
  bytes: unlimitedOr(z.number().int().min(0).max(10 * 1024 ** 4)), // up to 10 TB
  boolean: z.boolean(),
  resolution: z.enum(RESOLUTION_TIERS),
  resolutions: z.array(z.enum(RESOLUTION_TIERS)).min(1).transform((list) => Array.from(new Set(list))),
  policy: z.enum(['downscale', 'block']),
};

/** Validates one limit's value. Returns the parsed value or an error message. */
export function parseQuotaValue(
  key: string,
  value: unknown
): { ok: true; value: unknown } | { ok: false; error: string } {
  const field = getQuotaField(key);
  if (!field) return { ok: false, error: `Unknown limit "${key}"` };

  const result = VALUE_SCHEMAS[field.type].safeParse(value);
  if (!result.success) {
    return { ok: false, error: `${field.label}: ${result.error.issues[0]?.message || 'invalid value'}` };
  }
  return { ok: true, value: result.data };
}
