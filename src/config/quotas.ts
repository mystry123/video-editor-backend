export interface UserQuota {
  maxTemplates: number;
  maxStorage: number;
  maxRenderMinutes: number;
  maxResolution: string;
  maxTranscriptionMinutes: number;
}

export const USER_QUOTAS: Record<string, UserQuota> = {
  free: {
    maxTemplates: -1,
    maxStorage: 500 * 1024 * 1024, // 500MB
    maxRenderMinutes: 10,
    maxResolution: '720p',
    maxTranscriptionMinutes: 30,
  },
  pro: {
    maxTemplates: -1,
    maxStorage: 10 * 1024 * 1024 * 1024, // 10GB
    maxRenderMinutes: 60,
    maxResolution: '1080p',
    maxTranscriptionMinutes: 300,
  },
  team: {
    maxTemplates: -1, // unlimited
    maxStorage: 100 * 1024 * 1024 * 1024, // 100GB
    maxRenderMinutes: 500,
    maxResolution: '4k',
    maxTranscriptionMinutes: -1,
  },
  admin: {
    maxTemplates: -1,
    maxStorage: -1,
    maxRenderMinutes: -1,
    maxResolution: '4k',
    maxTranscriptionMinutes: -1,
  },
};

export function getUserQuota(role: string): UserQuota {
  return USER_QUOTAS[role] || USER_QUOTAS.free;
}
