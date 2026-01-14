// services/quota.service.ts

import { User } from '../models/User';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface QuotaUsageUpdate {
  userId: string;
  type: 'storage' | 'renderMinutes' | 'transcriptionMinutes' | 'captionProjects' | 'captionRenderMinutes' | 'captionExports' | 'customPresets';
  amount: number; // Positive for usage, negative for refunds/credits
  metadata?: {
    jobId?: string;
    projectId?: string;
    fileId?: string;
    transcriptionId?: string;
    templateId?: string;
    renderJobId?: string;
    presetId?: string;
    resolution?: string;
    duration?: number;
    size?: number;
    operation?: string;
  };
}

export interface QuotaUsageRecord {
  userId: string;
  type: string;
  amount: number;
  createdAt: Date;
  metadata?: any;
}

// ============================================================================
// Quota Update Service
// ============================================================================

class QuotaService {
  private static instance: QuotaService;

  static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  // ============================================================================
  // Core Update Methods
  // ============================================================================

  /**
   * Update quota usage for a user
   */
  async updateUsage(update: QuotaUsageUpdate): Promise<boolean> {
    try {
      const { userId, type, amount, metadata } = update;

      // Validate amount
      if (amount === 0) return true;

      // Get user for current usage
      const user = await User.findById(userId);
      if (!user) {
        logger.error(`Quota update failed: User ${userId} not found`);
        return false;
      }

      // Update based on type
      let updateField: string;
      let logMessage: string;

      switch (type) {
        case 'storage':
          updateField = 'quotaUsage.storageUsed';
          logMessage = `Storage: ${this.formatBytes(amount)}`;
          break;

        case 'renderMinutes':
          updateField = 'quotaUsage.renderMinutesUsed';
          logMessage = `Render: ${amount.toFixed(1)} minutes`;
          break;

        case 'transcriptionMinutes':
          updateField = 'quotaUsage.transcriptionMinutesUsed';
          logMessage = `Transcription: ${amount.toFixed(1)} minutes`;
          break;

        case 'captionProjects':
          updateField = 'quotaUsage.captionProjectsUsed';
          logMessage = `Caption project: ${amount > 0 ? '+1' : '-1'}`;
          break;

        case 'captionRenderMinutes':
          updateField = 'quotaUsage.captionRenderMinutesUsed';
          logMessage = `Caption render: ${amount.toFixed(1)} minutes`;
          break;

        case 'captionExports':
          updateField = 'quotaUsage.captionExportsUsed';
          logMessage = `Caption export: ${amount > 0 ? '+1' : '-1'}`;
          break;

        case 'customPresets':
          updateField = 'quotaUsage.customPresetsUsed';
          logMessage = `Custom preset: ${amount > 0 ? '+1' : '-1'}`;
          break;

        default:
          logger.error(`Unknown quota type: ${type}`);
          return false;
      }

      // Update user quota usage
      await User.updateOne(
        { _id: userId },
        {
          $inc: { [updateField]: amount },
          $set: { 'quotaUsage.lastUpdated': new Date() },
        }
      );

      // Log the update
      logger.info(`[Quota] User ${userId.slice(-6)}: ${logMessage}`, {
        type,
        amount,
        metadata,
      });

      return true;
    } catch (error: any) {
      logger.error(`Quota update failed:`, error);
      return false;
    }
  }

  /**
   * Record quota usage for analytics (optional)
   */
  async recordUsage(update: QuotaUsageUpdate): Promise<void> {
    try {
      // This could be stored in a separate collection for analytics
      // For now, we'll just log it
      logger.debug(`[Quota] Recorded usage:`, update);
    } catch (error) {
      // Don't fail the main operation if recording fails
      logger.warn(`Failed to record quota usage:`, error);
    }
  }

  // ============================================================================
  // Convenience Methods for Common Operations
  // ============================================================================

  async addStorageUsage(userId: string, bytes: number, fileId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'storage',
      amount: bytes,
      metadata: { fileId, operation: 'file_upload' },
    });
  }

  async removeStorageUsage(userId: string, bytes: number, fileId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'storage',
      amount: -bytes,
      metadata: { fileId, operation: 'file_delete' },
    });
  }

  async addRenderMinutes(userId: string, minutes: number, renderJobId?: string, resolution?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'renderMinutes',
      amount: minutes,
      metadata: { renderJobId, resolution, operation: 'render_complete' },
    });
  }

  async addTranscriptionMinutes(userId: string, minutes: number, transcriptionId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'transcriptionMinutes',
      amount: minutes,
      metadata: { transcriptionId, operation: 'transcription_complete' },
    });
  }

  async addCaptionProject(userId: string, projectId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'captionProjects',
      amount: 1,
      metadata: { projectId, operation: 'caption_project_created' },
    });
  }

  async removeCaptionProject(userId: string, projectId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'captionProjects',
      amount: -1,
      metadata: { projectId, operation: 'caption_project_deleted' },
    });
  }

  async addCaptionRenderMinutes(userId: string, minutes: number, renderJobId?: string, resolution?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'captionRenderMinutes',
      amount: minutes,
      metadata: { renderJobId, resolution, operation: 'caption_render_complete' },
    });
  }

  async addCaptionExport(userId: string, projectId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'captionExports',
      amount: 1,
      metadata: { projectId, operation: 'caption_export' },
    });
  }

  async addCustomPreset(userId: string, presetId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'customPresets',
      amount: 1,
      metadata: { presetId, operation: 'custom_preset_created' },
    });
  }

  async removeCustomPreset(userId: string, presetId?: string): Promise<boolean> {
    return this.updateUsage({
      userId,
      type: 'customPresets',
      amount: -1,
      metadata: { presetId, operation: 'custom_preset_deleted' },
    });
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  // ============================================================================
  // Reset Methods (for monthly resets)
  // ============================================================================

  async resetMonthlyUsage(userId: string): Promise<boolean> {
    try {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'quotaUsage.renderMinutesUsed': 0,
            'quotaUsage.transcriptionMinutesUsed': 0,
            'quotaUsage.captionRenderMinutesUsed': 0,
            'quotaUsage.captionExportsUsed': 0,
            'quotaUsage.lastReset': new Date(),
          },
        }
      );

      logger.info(`[Quota] Reset monthly usage for user ${userId.slice(-6)}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to reset monthly usage:`, error);
      return false;
    }
  }

  async resetAllMonthlyUsage(): Promise<void> {
    try {
      // This would typically be run by a cron job monthly
      const result = await User.updateMany(
        {},
        {
          $set: {
            'quotaUsage.renderMinutesUsed': 0,
            'quotaUsage.transcriptionMinutesUsed': 0,
            'quotaUsage.captionRenderMinutesUsed': 0,
            'quotaUsage.captionExportsUsed': 0,
            'quotaUsage.lastReset': new Date(),
          },
        }
      );

      logger.info(`[Quota] Reset monthly usage for ${result.modifiedCount} users`);
    } catch (error: any) {
      logger.error(`Failed to reset all monthly usage:`, error);
    }
  }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const quotaService = QuotaService.getInstance();
export default quotaService;
