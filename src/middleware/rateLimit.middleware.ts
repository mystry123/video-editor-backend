// middleware/rateLimiter.ts

import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

interface LimiterConfig {
  windowMs: number;
  max: number;
  prefix: string;
  message: string;
  keyGenerator?: (req: Request) => string;
}

// ============================================================================
// Redis Store - Lazy Loading
// ============================================================================

let RedisStore: any = null;
let redisStoreChecked = false;

async function getRedisStore(prefix: string): Promise<any> {
  // Only try once to load RedisStore
  if (!redisStoreChecked) {
    redisStoreChecked = true;
    try {
      const module = await import('rate-limit-redis');
      RedisStore = module.default;
    } catch {
      logger.warn('rate-limit-redis not available, using memory store');
    }
  }

  if (!RedisStore) return undefined;

  try {
    // Dynamic import to avoid loading at module initialization
    const { getRedis, isRedisReady } = await import('../config/redis');

    if (!isRedisReady()) {
      return undefined;
    }

    const redis = getRedis();

    return new RedisStore({
      sendCommand: async (...args: string[]) => {
        return await (redis as any).call(...args);
      },
      prefix: `rl:${prefix}:`,
    });
  } catch (error) {
    logger.warn(`Redis store creation failed for ${prefix}`);
    return undefined;
  }
}

// ============================================================================
// Rate Limiter Factory
// ============================================================================

function createLimiterOptions(config: LimiterConfig): Partial<Options> {
  const { windowMs, max, message, keyGenerator } = config;

  return {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    keyGenerator: keyGenerator || ((req: Request) => (req as any).userId || req.ip || 'anonymous'),
    handler: (req: Request, res: Response) => {
      logger.warn(`Rate limit hit: ${config.prefix}`, { ip: req.ip, path: req.path });
      res.status(429).json({ error: message });
    },
  };
}

function createLimiter(config: LimiterConfig): RequestHandler {
  const options = createLimiterOptions(config);

  // Start with memory store
  let currentLimiter = rateLimit(options as Options);

  // Try to upgrade to Redis store after 2 seconds (give Redis time to connect)
  setTimeout(async () => {
    try {
      const store = await getRedisStore(config.prefix);
      if (store) {
        currentLimiter = rateLimit({
          ...options,
          store,
        } as Options);
        logger.info(`Rate limiter [${config.prefix}]: Upgraded to Redis`);
      }
    } catch {
      // Keep using memory store
    }
  }, 2000);

  // Return wrapper that uses current limiter
  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    return currentLimiter(req, res, next);
  };

  return handler;
}

// ============================================================================
// Pre-configured Rate Limiters
// ============================================================================

// General API limiter - 100 req/min
export const rateLimiter:RequestHandler = createLimiter({
  windowMs: 60 * 1000,
  max: 100,
  prefix: 'general',
  message: 'Too many requests, please try again later',
});

// Render limiter - 100 renders/min per user
export const renderLimiter:RequestHandler = createLimiter({
  windowMs: 60 * 1000,
  max: 100,
  prefix: 'render',
  message: 'Render limit exceeded, please try again later',
});

// Progress check limiter - 1000 req/min per user
export const progressLimiter:RequestHandler = createLimiter({
  windowMs: 60 * 1000,
  max: 1000,
  prefix: 'progress',
  message: 'Progress check limit exceeded',
});

// Upload limiter - 50 uploads/hour per user
export const uploadLimiter:RequestHandler = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 50,
  prefix: 'upload',
  message: 'Upload limit exceeded, please try again in 1 hour',
});

// Auth limiter - 10 attempts/15min per IP
export const authLimiter: RequestHandler = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: 'auth',
  message: 'Too many login attempts, please try again later',
  keyGenerator: (req: Request) => req.ip || 'anonymous',
});

// Caption limiter - 20 captions/hour per user
export const captionLimiter: RequestHandler = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: 'caption',
  message: 'Caption limit exceeded, please try again in 1 hour',
});

// Transcription limiter - 30 transcriptions/hour per user
export const transcriptionLimiter:RequestHandler = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: 'transcription',
  message: 'Transcription limit exceeded, please try again in 1 hour',
});