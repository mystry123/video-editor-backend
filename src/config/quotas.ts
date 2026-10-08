export interface UserQuota {
  // Existing limits
  maxTemplates: number;
  maxStorage: number;
  maxRenderMinutes: number;
  maxResolution: string;
  maxTranscriptionMinutes: number;
  
  // Caption service limits
  maxCaptionProjects: number;        // Max active caption projects
  maxCaptionRenderMinutes: number;   // Separate from regular render minutes
  maxCaptionExports: number;         // Monthly exports
  allowedCaptionResolutions: string[]; // Which resolutions can they use
  maxVideoUploadSize: number;        // Max video file size for captions
  maxVideoDuration: number;          // Max video duration in seconds
  customPresetsAllowed: boolean;     // Can create custom presets
  maxCustomPresets: number;          // How many custom presets
  priorityRendering: boolean;        // Priority queue for rendering
  watermarkFree: boolean;            // No watermark on exports
  /** What happens when a render is above maxResolution. */
  overResolution: OverResolutionPolicy;
}

export type OverResolutionPolicy = 'downscale' | 'block';

export const USER_QUOTAS: Record<string, UserQuota> = {
  free: {
    // Existing
    maxTemplates: -1,
    maxStorage: 500 * 1024 * 1024, // 500MB
    maxRenderMinutes: 1,
    maxResolution: '720p',
    maxTranscriptionMinutes: 30,
    
    // Caption service
    maxCaptionProjects: 3,
    maxCaptionRenderMinutes: 5,
    maxCaptionExports: 3,              // 3 exports per month
    allowedCaptionResolutions: ['720p'],
    maxVideoUploadSize: 100 * 1024 * 1024, // 100MB
    maxVideoDuration: 60,              // 1 minute max
    customPresetsAllowed: false,
    maxCustomPresets: 0,
    priorityRendering: false,
    watermarkFree: false,
    overResolution: 'downscale',
  },
  pro: {
    // Existing
    maxTemplates: -1,
    maxStorage: 10 * 1024 * 1024 * 1024, // 10GB
    maxRenderMinutes: 60,
    maxResolution: '1080p',
    maxTranscriptionMinutes: 300,
    
    // Caption service
    maxCaptionProjects: 25,
    maxCaptionRenderMinutes: 120,
    maxCaptionExports: 50,             // 50 exports per month
    allowedCaptionResolutions: ['720p', '1080p'],
    maxVideoUploadSize: 500 * 1024 * 1024, // 500MB
    maxVideoDuration: 600,             // 10 minutes max
    customPresetsAllowed: true,
    maxCustomPresets: 10,
    priorityRendering: false,
    watermarkFree: true,
    overResolution: 'downscale',
  },
  team: {
    // Existing
    maxTemplates: -1,
    maxStorage: 100 * 1024 * 1024 * 1024, // 100GB
    maxRenderMinutes: 500,
    maxResolution: '4k',
    maxTranscriptionMinutes: -1,
    
    // Caption service
    maxCaptionProjects: -1,            // Unlimited
    maxCaptionRenderMinutes: -1,       // Unlimited
    maxCaptionExports: -1,             // Unlimited
    allowedCaptionResolutions: ['720p', '1080p', '4k'],
    maxVideoUploadSize: 2 * 1024 * 1024 * 1024, // 2GB
    maxVideoDuration: 3600,            // 1 hour max
    customPresetsAllowed: true,
    maxCustomPresets: -1,              // Unlimited
    priorityRendering: true,
    watermarkFree: true,
    overResolution: 'downscale',
  },
  admin: {
    // Existing
    maxTemplates: -1,
    maxStorage: -1,
    maxRenderMinutes: -1,
    maxResolution: '4k',
    maxTranscriptionMinutes: -1,
    
    // Caption service
    maxCaptionProjects: -1,
    maxCaptionRenderMinutes: -1,
    maxCaptionExports: -1,
    allowedCaptionResolutions: ['720p', '1080p', '4k'],
    maxVideoUploadSize: -1,
    maxVideoDuration: -1,
    customPresetsAllowed: true,
    maxCustomPresets: -1,
    priorityRendering: true,
    watermarkFree: true,
    overResolution: 'downscale',
  },
};

// ============================================================================
// Plan resolution
//
// Plans live in the `plans` collection (editable from the admin settings) and
// are cached in memory by services/plan.service.ts, which registers itself
// here. USER_QUOTAS above is the seed and the fallback if the cache is empty.
// ============================================================================

type PlanResolver = (planKey: string) => UserQuota | undefined;
let planResolver: PlanResolver | null = null;

export function setPlanResolver(resolver: PlanResolver): void {
  planResolver = resolver;
}

/** Limits for a plan, without any per-user overrides. */
export function getUserQuota(role: string): UserQuota {
  return planResolver?.(role) || USER_QUOTAS[role] || USER_QUOTAS.free;
}

export interface PlanOverride {
  _id?: unknown;
  field: keyof UserQuota | string;
  value: unknown;
  expiresAt?: Date | null;
  note?: string;
}

export function isOverrideActive(override: PlanOverride, now = new Date()): boolean {
  return !override.expiresAt || new Date(override.expiresAt) > now;
}

/**
 * Limits that actually apply to this user: their plan, with any unexpired
 * per-user overrides on top. Use this wherever a user document is available.
 */
export function getEffectiveQuota(user: { role: string; planOverrides?: PlanOverride[] }): UserQuota {
  const quota: UserQuota = { ...getUserQuota(user.role) };
  const now = new Date();
  for (const override of user.planOverrides || []) {
    if (isOverrideActive(override, now) && override.field in quota) {
      (quota as any)[override.field] = override.value;
    }
  }
  return quota;
}

// Helper to check if a value is unlimited
export function isUnlimited(value: number): boolean {
  return value === -1;
}

// Helper to check if user can use a specific resolution
export function canUseResolution(role: string, resolution: string): boolean {
  const quota = getUserQuota(role);
  return quota.allowedCaptionResolutions.includes(resolution);
}

// Helper to get max allowed resolution for a user
export function getMaxResolution(role: string): string {
  const quota = getUserQuota(role);
  const resolutionOrder = ['720p', '1080p', '4k'];
  for (let i = resolutionOrder.length - 1; i >= 0; i--) {
    if (quota.allowedCaptionResolutions.includes(resolutionOrder[i])) {
      return resolutionOrder[i];
    }
  }
  return '720p';
}