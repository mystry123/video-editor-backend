// bootstrap.ts
//
// Startup shared by the API server (index.ts) and the worker process
// (worker.ts), so both connect and configure themselves the same way.

import { connectDatabase } from './config/database';
import { connectRedis, waitForRedis } from './config/redis';
import { initializeQuotaSystem, migrateExistingUsers } from './config/quota-init';
import { initPlans } from './services/plan.service';
import { ffprobeAvailable } from './utils/media';
import { logger } from './utils/logger';
import { env } from './config/env';

/** MongoDB, quotas and plans. */
export async function initCore(): Promise<void> {
  await connectDatabase();
  logger.info('✅ MongoDB connected');

  initializeQuotaSystem();
  // Plans are editable in the admin settings; falls back to code defaults if this fails.
  try {
    await initPlans();
  } catch (error: any) {
    logger.error('Failed to load plans; using built-in defaults', { error: error.message });
  }

  // Migrate existing users (run once)
  if (env.nodeEnv === 'development') {
    await migrateExistingUsers();
  }
  logger.info('✅ Quota system initialized');
}

/** Connects Redis; resolves whether it's usable within `timeoutMs`. */
export async function initRedis(timeoutMs = 5000): Promise<boolean> {
  try {
    await connectRedis();
    return await waitForRedis(timeoutMs);
  } catch (error: any) {
    logger.warn(`⚠️ Redis connection error: ${error.message}`);
    return false;
  }
}

/**
 * Uploads, captions and reframe all need ffprobe/ffmpeg. Missing binaries
 * (e.g. the pnpm postinstall being skipped on deploy) otherwise only show up
 * later as files with 0s duration.
 */
export function checkMediaTools(): void {
  ffprobeAvailable().then((ok) => {
    if (!ok) logger.error('❌ ffprobe is not available: media uploads will have no duration/size. Check FFPROBE_PATH or the ffmpeg install.');
  });
}
