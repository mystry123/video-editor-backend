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
}

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
  },
};

export function getUserQuota(role: string): UserQuota {
  return USER_QUOTAS[role] || USER_QUOTAS.free;
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