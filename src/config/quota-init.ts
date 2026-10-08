// config/quota-init.ts

import { User } from '../models/User';
import { File } from '../models/File';
import { Template } from '../models/Template';
import { RenderJob } from '../models/RenderJob';
import { Transcription } from '../models/Transcription';
import { CaptionProject } from '../models/Caption';
import { CaptionPreset } from '../models/CaptionPreset';
import { initializeQuotaMiddleware } from '../middleware/quota.middleware';
import { getMonthlyTotal } from '../services/usage.service';
import { logger } from '../utils/logger';

// ============================================================================
// Initialize Quota Middleware with Database Fetchers
// ============================================================================

export function initializeQuotaSystem(): void {
  logger.info('Initializing quota system...');

  initializeQuotaMiddleware({
    // Storage usage - from User.quotaUsage.storageUsed
    getStorageUsed: async (userId: string) => {
      try {
        const user = await User.findById(userId).select('quotaUsage.storageUsed');
        return user?.quotaUsage?.storageUsed || 0;
      } catch (error) {
        logger.error(`Failed to get storage usage for user ${userId}:`, error);
        return 0;
      }
    },

    // Template count - count active templates
    getTemplateCount: async (userId: string) => {
      try {
        return await Template.countDocuments({ 
          userId, 
          deletedAt: { $exists: false } 
        });
      } catch (error) {
        logger.error(`Failed to get template count for user ${userId}:`, error);
        return 0;
      }
    },

    // Render minutes used this month - from the usage ledger
    getRenderMinutesUsed: async (userId: string, _since: Date) => {
      try {
        // This month's ledger total (resets with the month).
        return (await getMonthlyTotal(userId, 'renderMinutes')) / 60;
      } catch (error) {
        logger.error(`Failed to get render minutes for user ${userId}:`, error);
        return 0;
      }
    },

    // Transcription minutes used this month - from the usage ledger
    getTranscriptionMinutesUsed: async (userId: string, _since: Date) => {
      try {
        // This month's ledger total (resets with the month).
        return (await getMonthlyTotal(userId, 'transcriptionMinutes')) / 60;
      } catch (error) {
        logger.error(`Failed to get transcription minutes for user ${userId}:`, error);
        return 0;
      }
    },

    // Active caption projects - count non-completed projects
    getActiveCaptionProjects: async (userId: string) => {
      try {
        return await CaptionProject.countDocuments({
          userId,
          status: { $in: ['pending', 'transcribing', 'generating', 'rendering'] }
        });
      } catch (error) {
        logger.error(`Failed to get active caption projects for user ${userId}:`, error);
        return 0;
      }
    },

    // Caption render minutes used this month - from the usage ledger
    getCaptionRenderMinutesUsed: async (userId: string, _since: Date) => {
      try {
        // This month's ledger total (resets with the month).
        return (await getMonthlyTotal(userId, 'captionRenderMinutes')) / 60;
      } catch (error) {
        logger.error(`Failed to get caption render minutes for user ${userId}:`, error);
        return 0;
      }
    },

    // Caption exports this month - from the usage ledger
    getCaptionExportsCount: async (userId: string, _since: Date) => {
      try {
        // This month's ledger total (resets with the month).
        return await getMonthlyTotal(userId, 'captionExports');
      } catch (error) {
        logger.error(`Failed to get caption exports for user ${userId}:`, error);
        return 0;
      }
    },

    // Custom presets count - count user's custom presets
    getCustomPresetsCount: async (userId: string) => {
      try {
        return await CaptionPreset.countDocuments({ userId, isSystem: false });
      } catch (error) {
        logger.error(`Failed to get custom presets for user ${userId}:`, error);
        return 0;
      }
    },
  });

  logger.info('✅ Quota system initialized');
}

// ============================================================================
// Monthly Reset Function (for cron job)
// ============================================================================

export async function performMonthlyReset(): Promise<void> {
  try {
    logger.info('Starting monthly quota reset...');
    
    // Reset monthly counters for all users
    const result = await User.updateMany(
      {},
      {
        $set: {
          'quotaUsage.renderMinutesUsed': 0,
          'quotaUsage.transcriptionMinutesUsed': 0,
          'quotaUsage.captionRenderMinutesUsed': 0,
          'quotaUsage.captionExportsUsed': 0,
          'quotaUsage.lastReset': new Date(),
        }
      }
    );

    logger.info(`✅ Monthly reset completed for ${result.modifiedCount} users`);
  } catch (error) {
    logger.error('Monthly reset failed:', error);
  }
}

// ============================================================================
// Migration Function (for existing users)
// ============================================================================

export async function migrateExistingUsers(): Promise<void> {
  try {
    logger.info('Migrating existing users to quota tracking...');
    
    // Find users without quotaUsage field
    const usersWithoutQuota = await User.find({ quotaUsage: { $exists: false } });
    
    for (const user of usersWithoutQuota) {
      // Initialize quotaUsage with existing storageUsed
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            quotaUsage: {
              storageUsed: user.storageUsed || 0,
              renderMinutesUsed: 0,
              transcriptionMinutesUsed: 0,
              captionProjectsUsed: 0,
              captionRenderMinutesUsed: 0,
              captionExportsUsed: 0,
              customPresetsUsed: 0,
              lastUpdated: new Date(),
              lastReset: new Date(),
            }
          }
        }
      );
    }
    
    logger.info(`✅ Migrated ${usersWithoutQuota.length} users to quota tracking`);
  } catch (error) {
    logger.error('User migration failed:', error);
  }
}
