import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { getUserQuota, isUnlimited, UserQuota } from '../config/quotas';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface AuthenticatedRequest extends Request {
  user?: {
    _id: string | Types.ObjectId;
    role: string;
    email: string;
    plan?: string;
  };
  userId?: string;
  file?: {
    size: number;
    [key: string]: any;
  };
  videoMetadata?: {
    size?: number;
    [key: string]: any;
  };
  usageSummary?: UsageSummary;
  quotaContext?: QuotaContext;
}

export interface QuotaCheckResult {
  allowed: boolean;
  currentUsage: number;
  limit: number;
  remaining: number;
  message?: string;
  code?: string;
}

export interface QuotaContext {
  userId: string;
  role: string;
  quota: UserQuota;
  checks: Record<string, QuotaCheckResult>;
}

export interface UsageSummary {
  storage: QuotaCheckResult;
  templates: QuotaCheckResult;
  renderMinutes: QuotaCheckResult;
  transcriptionMinutes: QuotaCheckResult;
  captionProjects: QuotaCheckResult;
  captionRenderMinutes: QuotaCheckResult;
  captionExports: QuotaCheckResult;
  customPresets: QuotaCheckResult;
}

// Quota check types
export type QuotaCheckType =
  // Storage & Templates
  | 'storage'
  | 'templates'
  // Render & Transcription (existing)
  | 'renderMinutes'
  | 'transcriptionMinutes'
  | 'resolution'
  // Caption-specific
  | 'captionProjects'
  | 'captionRenderMinutes'
  | 'captionExports'
  | 'captionResolution'
  | 'captionVideoUpload'
  | 'captionVideoDuration'
  | 'customPresets';

// Error codes mapping
const QUOTA_ERROR_CODES: Record<QuotaCheckType, string> = {
  storage: 'STORAGE_LIMIT_EXCEEDED',
  templates: 'TEMPLATE_LIMIT_EXCEEDED',
  renderMinutes: 'RENDER_MINUTES_EXCEEDED',
  transcriptionMinutes: 'TRANSCRIPTION_MINUTES_EXCEEDED',
  resolution: 'RESOLUTION_NOT_ALLOWED',
  captionProjects: 'CAPTION_PROJECT_LIMIT_REACHED',
  captionRenderMinutes: 'CAPTION_RENDER_MINUTES_EXCEEDED',
  captionExports: 'CAPTION_EXPORT_LIMIT_REACHED',
  captionResolution: 'CAPTION_RESOLUTION_NOT_ALLOWED',
  captionVideoUpload: 'VIDEO_UPLOAD_SIZE_EXCEEDED',
  captionVideoDuration: 'VIDEO_DURATION_EXCEEDED',
  customPresets: 'CUSTOM_PRESET_LIMIT_REACHED',
};

// ============================================================================
// Usage Fetchers (Abstract database calls)
// ============================================================================

export interface UsageFetchers {
  getStorageUsed: (userId: string) => Promise<number>;
  getTemplateCount: (userId: string) => Promise<number>;
  getRenderMinutesUsed: (userId: string, since: Date) => Promise<number>;
  getTranscriptionMinutesUsed: (userId: string, since: Date) => Promise<number>;
  getActiveCaptionProjects: (userId: string) => Promise<number>;
  getCaptionRenderMinutesUsed: (userId: string, since: Date) => Promise<number>;
  getCaptionExportsCount: (userId: string, since: Date) => Promise<number>;
  getCustomPresetsCount: (userId: string) => Promise<number>;
}

// Default fetchers - should be overridden with actual implementations
let usageFetchers: UsageFetchers = {
  getStorageUsed: async () => 0,
  getTemplateCount: async () => 0,
  getRenderMinutesUsed: async () => 0,
  getTranscriptionMinutesUsed: async () => 0,
  getActiveCaptionProjects: async () => 0,
  getCaptionRenderMinutesUsed: async () => 0,
  getCaptionExportsCount: async () => 0,
  getCustomPresetsCount: async () => 0,
};

/**
 * Initialize quota middleware with actual database fetchers
 */
export function initializeQuotaMiddleware(fetchers: Partial<UsageFetchers>): void {
  usageFetchers = { ...usageFetchers, ...fetchers };
}

// ============================================================================
// Core Quota Check Functions
// ============================================================================

function getStartOfMonth(): Date {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

const quotaCheckers: Record<
  QuotaCheckType,
  (
    userId: string,
    quota: UserQuota,
    context?: { value?: number; resolution?: string }
  ) => Promise<QuotaCheckResult> | QuotaCheckResult
> = {
  // Storage check
  storage: async (userId, quota, context) => {
    if (isUnlimited(quota.maxStorage)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const used = await usageFetchers.getStorageUsed(userId);
    const valueToAdd = context?.value || 0;
    const remaining = quota.maxStorage - used;
    
    return {
      allowed: remaining >= valueToAdd,
      currentUsage: used,
      limit: quota.maxStorage,
      remaining: Math.max(0, remaining),
      message: remaining < valueToAdd
        ? `Storage limit exceeded. You have ${formatBytes(remaining)} remaining, but need ${formatBytes(valueToAdd)}.`
        : undefined,
      code: QUOTA_ERROR_CODES.storage,
    };
  },

  // Template count check
  templates: async (userId, quota) => {
    if (isUnlimited(quota.maxTemplates)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const count = await usageFetchers.getTemplateCount(userId);
    const remaining = quota.maxTemplates - count;
    
    return {
      allowed: remaining > 0,
      currentUsage: count,
      limit: quota.maxTemplates,
      remaining: Math.max(0, remaining),
      message: remaining <= 0
        ? `Template limit reached. Maximum ${quota.maxTemplates} templates allowed.`
        : undefined,
      code: QUOTA_ERROR_CODES.templates,
    };
  },

  // Render minutes (existing system)
  renderMinutes: async (userId, quota, context) => {
    if (isUnlimited(quota.maxRenderMinutes)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const used = await usageFetchers.getRenderMinutesUsed(userId, getStartOfMonth());
    const valueToAdd = (context?.value || 0) / 60; // Convert seconds to minutes
    const remaining = quota.maxRenderMinutes - used;
    
    return {
      allowed: remaining >= valueToAdd,
      currentUsage: Math.round(used * 100) / 100,
      limit: quota.maxRenderMinutes,
      remaining: Math.max(0, Math.round(remaining * 100) / 100),
      message: remaining < valueToAdd
        ? `Render minutes exceeded. You have ${remaining.toFixed(1)} minutes remaining this month.`
        : undefined,
      code: QUOTA_ERROR_CODES.renderMinutes,
    };
  },

  // Transcription minutes
  transcriptionMinutes: async (userId, quota, context) => {
    if (isUnlimited(quota.maxTranscriptionMinutes)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const used = await usageFetchers.getTranscriptionMinutesUsed(userId, getStartOfMonth());
    const valueToAdd = (context?.value || 0) / 60; // Convert seconds to minutes
    const remaining = quota.maxTranscriptionMinutes - used;
    
    return {
      allowed: remaining >= valueToAdd,
      currentUsage: Math.round(used * 100) / 100,
      limit: quota.maxTranscriptionMinutes,
      remaining: Math.max(0, Math.round(remaining * 100) / 100),
      message: remaining < valueToAdd
        ? `Transcription minutes exceeded. You have ${remaining.toFixed(1)} minutes remaining this month.`
        : undefined,
      code: QUOTA_ERROR_CODES.transcriptionMinutes,
    };
  },

  // Resolution check (existing)
  resolution: (userId, quota, context) => {
    const resolution = context?.resolution || '1080p';
    const maxRes = quota.maxResolution;
    const resolutionOrder = ['720p', '1080p', '4k'];
    const requestedIndex = resolutionOrder.indexOf(resolution);
    const maxIndex = resolutionOrder.indexOf(maxRes);
    const allowed = requestedIndex <= maxIndex;
    
    return {
      allowed,
      currentUsage: 0,
      limit: 0,
      remaining: 0,
      message: !allowed
        ? `${resolution} resolution not available on your plan. Maximum: ${maxRes}.`
        : undefined,
      code: QUOTA_ERROR_CODES.resolution,
    };
  },

  // Caption projects
  captionProjects: async (userId, quota) => {
    if (isUnlimited(quota.maxCaptionProjects)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const count = await usageFetchers.getActiveCaptionProjects(userId);
    const remaining = quota.maxCaptionProjects - count;
    
    return {
      allowed: remaining > 0,
      currentUsage: count,
      limit: quota.maxCaptionProjects,
      remaining,
      message: remaining <= 0
        ? `Monthly caption project limit reached (${quota.maxCaptionProjects}). Upgrade for more projects.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionProjects,
    };
  },

  // Caption resolution
  captionResolution: (userId, quota, context) => {
    const resolution = context?.resolution || '1080p';
    const allowed = quota.allowedCaptionResolutions.includes(resolution);
    
    return {
      allowed,
      currentUsage: 0,
      limit: 0,
      remaining: 0,
      message: !allowed
        ? `${resolution} not available. Allowed: ${quota.allowedCaptionResolutions.join(', ')}.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionResolution,
    };
  },

  // Caption video upload size
  captionVideoUpload: (userId, quota, context) => {
    if (isUnlimited(quota.maxVideoUploadSize)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const fileSize = context?.value || 0;
    const allowed = fileSize <= quota.maxVideoUploadSize;
    
    return {
      allowed,
      currentUsage: fileSize,
      limit: quota.maxVideoUploadSize,
      remaining: Math.max(0, quota.maxVideoUploadSize - fileSize),
      message: !allowed
        ? `File size (${formatBytes(fileSize)}) exceeds limit of ${formatBytes(quota.maxVideoUploadSize)}.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionVideoUpload,
    };
  },

  // Caption video duration
  captionVideoDuration: (userId, quota, context) => {
    if (isUnlimited(quota.maxVideoDuration)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const duration = context?.value || 0;
    const allowed = duration <= quota.maxVideoDuration;
    
    return {
      allowed,
      currentUsage: duration,
      limit: quota.maxVideoDuration,
      remaining: Math.max(0, quota.maxVideoDuration - duration),
      message: !allowed
        ? `Video duration (${formatDuration(duration)}) exceeds limit of ${formatDuration(quota.maxVideoDuration)}.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionVideoDuration,
    };
  },

  // Custom presets
  customPresets: async (userId, quota) => {
    if (!quota.customPresetsAllowed) {
      return {
        allowed: false,
        currentUsage: 0,
        limit: 0,
        remaining: 0,
        message: 'Custom presets not available on your plan. Upgrade to create custom presets.',
        code: QUOTA_ERROR_CODES.customPresets,
      };
    }
    
    if (isUnlimited(quota.maxCustomPresets)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const count = await usageFetchers.getCustomPresetsCount(userId);
    const remaining = quota.maxCustomPresets - count;
    
    return {
      allowed: remaining > 0,
      currentUsage: count,
      limit: quota.maxCustomPresets,
      remaining: Math.max(0, remaining),
      message: remaining <= 0
        ? `Custom preset limit reached (${quota.maxCustomPresets}). Delete existing presets or upgrade.`
        : undefined,
      code: QUOTA_ERROR_CODES.customPresets,
    };
  },

  // Caption render minutes
  captionRenderMinutes: async (userId, quota) => {
    if (isUnlimited(quota.maxCaptionRenderMinutes)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const used = await usageFetchers.getCaptionRenderMinutesUsed(userId, getStartOfMonth());
    const remaining = quota.maxCaptionRenderMinutes - used;
    
    return {
      allowed: remaining > 0,
      currentUsage: used,
      limit: quota.maxCaptionRenderMinutes,
      remaining: Math.max(0, remaining),
      message: remaining <= 0
        ? `Monthly render minutes limit reached (${quota.maxCaptionRenderMinutes}). Upgrade for more render time.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionRenderMinutes,
    };
  },

  // Caption exports
  captionExports: async (userId, quota) => {
    if (isUnlimited(quota.maxCaptionExports)) {
      return { allowed: true, currentUsage: 0, limit: -1, remaining: -1 };
    }
    
    const count = await usageFetchers.getCaptionExportsCount(userId, getStartOfMonth());
    const remaining = quota.maxCaptionExports - count;
    
    return {
      allowed: remaining > 0,
      currentUsage: count,
      limit: quota.maxCaptionExports,
      remaining: Math.max(0, remaining),
      message: remaining <= 0
        ? `Monthly export limit reached (${quota.maxCaptionExports}). Upgrade for more exports.`
        : undefined,
      code: QUOTA_ERROR_CODES.captionExports,
    };
  },
};

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

// ============================================================================
// Middleware Factory
// ============================================================================

export interface QuotaCheckOptions {
  checks: QuotaCheckType[];
  getContext?: (req: AuthenticatedRequest) => {
    value?: number;
    resolution?: string;
  };
  failFast?: boolean; // Stop on first failure (default: false, check all)
}

/**
 * Factory function to create quota check middleware
 */
export function checkQuota(options: QuotaCheckOptions) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userId = req.user._id.toString();
      const quota = getUserQuota(req.user.role);
      const context = options.getContext?.(req) || {};
      
      const results: Record<string, QuotaCheckResult> = {};
      const errors: Array<{ check: string; result: QuotaCheckResult }> = [];

      // Run checks (parallel or sequential based on failFast)
      if (options.failFast) {
        for (const checkType of options.checks) {
          const result = await quotaCheckers[checkType](userId, quota, context);
          results[checkType] = result;
          
          if (!result.allowed) {
            errors.push({ check: checkType, result });
            break;
          }
        }
      } else {
        const checkPromises = options.checks.map(async (checkType) => {
          const result = await quotaCheckers[checkType](userId, quota, context);
          return { checkType, result };
        });
        
        const checkResults = await Promise.all(checkPromises);
        
        for (const { checkType, result } of checkResults) {
          results[checkType] = result;
          if (!result.allowed) {
            errors.push({ check: checkType, result });
          }
        }
      }

      // Store context for later use
      req.quotaContext = {
        userId,
        role: req.user.role,
        quota,
        checks: results,
      };

      if (errors.length > 0) {
        const primaryError = errors[0];
        
        res.status(403).json({
          error: 'Quota exceeded',
          code: primaryError.result.code || QUOTA_ERROR_CODES[primaryError.check as QuotaCheckType],
          message: primaryError.result.message,
          checks: errors.length > 1 ? results : undefined,
          usage: {
            current: primaryError.result.currentUsage,
            limit: primaryError.result.limit,
            remaining: primaryError.result.remaining,
          },
          allErrors: errors.length > 1 
            ? errors.map(e => ({ 
                check: e.check, 
                message: e.result.message,
                code: e.result.code,
              }))
            : undefined,
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

// ============================================================================
// Pre-built Middleware Instances
// ============================================================================

// Storage
export const checkStorageQuota = (additionalBytes?: number) => 
  checkQuota({
    checks: ['storage'],
    getContext: (req) => ({ value: additionalBytes || req.body?.fileSize || 0 }),
  });

// Templates
export const checkTemplateQuota = checkQuota({
  checks: ['templates'],
});

// Render (existing system)
export const checkRenderQuota = checkQuota({
  checks: ['renderMinutes', 'resolution'],
  getContext: (req) => ({
    value: req.body?.duration || req.videoMetadata?.duration || 0,
    resolution: req.body?.resolution || '1080p',
  }),
});

// Transcription
export const checkTranscriptionQuota = checkQuota({
  checks: ['transcriptionMinutes'],
  getContext: (req) => ({
    value: req.body?.duration || req.videoMetadata?.duration || 0,
  }),
});

// Caption project creation
export const checkCaptionProjectQuota = checkQuota({
  checks: ['captionProjects'],
});

// Caption transcription
export const checkCaptionTranscriptionQuota = checkQuota({
  checks: ['transcriptionMinutes'],
  getContext: (req) => ({
    value: req.body?.duration || req.videoMetadata?.duration || 0,
  }),
});

// Caption render
export const checkCaptionRenderQuota = checkQuota({
  checks: ['captionRenderMinutes', 'captionResolution'],
  getContext: (req) => ({
    value: req.body?.duration || req.videoMetadata?.duration || 0,
    resolution: req.body?.resolution || req.body?.settings?.resolution || '1080p',
  }),
});

// Caption export
export const checkCaptionExportQuota = checkQuota({
  checks: ['captionExports'],
});

// Custom preset creation
export const checkCustomPresetQuota = checkQuota({
  checks: ['customPresets'],
});

// Video upload validation
export const checkVideoUploadQuota = checkQuota({
  checks: ['captionVideoUpload', 'captionVideoDuration'],
  getContext: (req) => ({
    value: req.file?.size || req.body?.fileSize || req.videoMetadata?.size || 0,
  }),
});

// Full caption flow validation (all checks at once)
export const checkFullCaptionFlowQuota = checkQuota({
  checks: [
    'captionProjects',
    'transcriptionMinutes',
    'captionRenderMinutes',
    'captionExports',
    'captionVideoUpload',
    'captionVideoDuration',
    'captionResolution',
  ],
  getContext: (req) => ({
    value: req.body?.duration || req.videoMetadata?.duration || 0,
    resolution: req.body?.resolution || req.body?.settings?.resolution || '1080p',
  }),
});

// ============================================================================
// Usage Summary Middleware
// ============================================================================

/**
 * Middleware to attach complete usage summary to request
 */
export const attachUsageSummary = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user._id.toString();
    const quota = getUserQuota(req.user.role);

    const [
      storage,
      templates,
      renderMinutes,
      transcriptionMinutes,
      captionProjects,
      captionRenderMinutes,
      captionExports,
      customPresets,
    ] = await Promise.all([
      quotaCheckers.storage(userId, quota, {}),
      quotaCheckers.templates(userId, quota, {}),
      quotaCheckers.renderMinutes(userId, quota, {}),
      quotaCheckers.transcriptionMinutes(userId, quota, {}),
      quotaCheckers.captionProjects(userId, quota, {}),
      quotaCheckers.captionRenderMinutes(userId, quota, {}),
      quotaCheckers.captionExports(userId, quota, {}),
      quotaCheckers.customPresets(userId, quota, {}),
    ]);

    req.usageSummary = {
      storage,
      templates,
      renderMinutes,
      transcriptionMinutes,
      captionProjects,
      captionRenderMinutes,
      captionExports,
      customPresets,
    };

    next();
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// Direct Check Functions (for use in services)
// ============================================================================

/**
 * Direct quota check function for use outside middleware
 */
export async function checkQuotaDirect(
  userId: string,
  role: string,
  checks: QuotaCheckType[],
  context?: { value?: number; resolution?: string }
): Promise<{ allowed: boolean; results: Record<string, QuotaCheckResult> }> {
  const quota = getUserQuota(role);
  const results: Record<string, QuotaCheckResult> = {};
  let allowed = true;

  for (const checkType of checks) {
    const result = await quotaCheckers[checkType](userId, quota, context);
    results[checkType] = result;
    if (!result.allowed) {
      allowed = false;
    }
  }

  return { allowed, results };
}

/**
 * Get user's complete quota status
 */
export async function getQuotaStatus(
  userId: string,
  role: string
): Promise<{ quota: UserQuota; usage: UsageSummary }> {
  const quota = getUserQuota(role);

  const [
    storage,
    templates,
    renderMinutes,
    transcriptionMinutes,
    captionProjects,
    captionRenderMinutes,
    captionExports,
    customPresets,
  ] = await Promise.all([
    quotaCheckers.storage(userId, quota, {}),
    quotaCheckers.templates(userId, quota, {}),
    quotaCheckers.renderMinutes(userId, quota, {}),
    quotaCheckers.transcriptionMinutes(userId, quota, {}),
    quotaCheckers.captionProjects(userId, quota, {}),
    quotaCheckers.captionRenderMinutes(userId, quota, {}),
    quotaCheckers.captionExports(userId, quota, {}),
    quotaCheckers.customPresets(userId, quota, {}),
  ]);

  return {
    quota,
    usage: {
      storage,
      templates,
      renderMinutes,
      transcriptionMinutes,
      captionProjects,
      captionRenderMinutes,
      captionExports,
      customPresets,
    },
  };
}