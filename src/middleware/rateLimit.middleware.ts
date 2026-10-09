// middleware/rateLimiter.ts
import { sendError } from '../utils/errorResponse';
import { onRedisReady } from '../config/redis';

import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import net from 'net';
import { env } from '../config/env';
import { verifyAccessToken, verifyRefreshToken } from '../utils/jwt';

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
// Who is calling
// ============================================================================

/** Headers the Remix server adds to its server-side calls (data/axios/axiosInstances.ts). */
export const PROXY_SECRET_HEADER = 'x-shotline-proxy-secret';
export const PROXY_CLIENT_IP_HEADER = 'x-shotline-client-ip';

function sameSecret(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The browser's IP. Normally req.ip (honours `trust proxy`, i.e. nginx). But
 * calls the Remix server makes while rendering a page arrive from the Remix
 * box, so every user would share its IP; when such a call carries the shared
 * INTERNAL_PROXY_SECRET, its X-Shotline-Client-IP header is used instead.
 * Without the secret that header is ignored: anyone could send it.
 */
export function clientIp(req: Request): string {
  const secret = env.internalProxySecret;
  const given = req.header(PROXY_SECRET_HEADER);
  if (secret.length >= 32 && given && sameSecret(given, secret)) {
    const forwarded = (req.header(PROXY_CLIENT_IP_HEADER) || '').trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return req.ip || 'anonymous';
}

/**
 * Key for per-caller limits: the signed-in user when the request carries a
 * valid access token (checked by signature, so an id can't be made up), else
 * the client IP. The general limiter runs before authentication, so
 * req.userId isn't set yet there. Revocation isn't checked here: a revoked token still names its user,
 * and the auth middleware rejects the request anyway.
 */
export function rateLimitKey(req: Request): string {
  // Limiters mounted after requireAuth: our own middleware set this (also
  // covers API keys).
  const authenticated = (req as Request & { userId?: string }).userId;
  if (authenticated) return `user:${authenticated}`;
  const header = req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    const payload = verifyAccessToken(header.slice(7)) as (ReturnType<typeof verifyAccessToken> & { tokenType?: string }) | null;
    if (payload?.userId && (!payload.tokenType || payload.tokenType === 'upload')) return `user:${payload.userId}`;
  }
  // POST /auth/refresh carries no access token; the Remix server sends it for
  // every visitor, so key it by the (verified) refresh token's user too.
  const refreshToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (typeof refreshToken === 'string' && refreshToken.length < 4096) {
    const payload = verifyRefreshToken(refreshToken);
    if (payload?.userId) return `user:${payload.userId}`;
  }
  return `ip:${clientIp(req)}`;
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
    keyGenerator: keyGenerator || rateLimitKey,
    handler: (req: Request, res: Response) => {
      logger.warn(`Rate limit hit: ${config.prefix}`, { ip: clientIp(req), path: req.path });
      sendError(req, res, 429, message, 'RATE_LIMITED');
    },
  };
}

function createLimiter(config: LimiterConfig): RequestHandler {
  const options = createLimiterOptions(config);

  // Start with memory store
  let currentLimiter = rateLimit(options as Options);

  // Switch to the shared Redis store as soon as Redis is ready (limits then
  // survive restarts and apply across processes). Until then, memory store.
  onRedisReady(() => {
    getRedisStore(config.prefix)
      .then((store) => {
        if (store) {
          currentLimiter = rateLimit({ ...options, store } as Options);
          logger.info(`Rate limiter [${config.prefix}]: Upgraded to Redis`);
        }
      })
      .catch(() => undefined); // keep the memory store
  });

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
// Public render links (/r/:id): generous, but stops token guessing.
export const renderLinkLimiter: RequestHandler = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  prefix: 'render-link',
  message: 'Too many requests for render links. Try again in a minute.',
});

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

// Auth limiter - 30 attempts/15min per IP across login, signup and password reset
export const authLimiter: RequestHandler = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: 'auth',
  message: 'Too many attempts. Wait a few minutes and try again.',
  keyGenerator: clientIp,
});

// Login limiter - 10 attempts/15min per IP + email, so guessing one account's
// password is slow even from many sessions, without locking out the real owner
// signing in from elsewhere.
export const loginLimiter: RequestHandler = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: 'login',
  message: 'Too many sign-in attempts for this account. Wait a few minutes and try again.',
  keyGenerator: (req: Request) => `${clientIp(req)}:${String(req.body?.email || '').toLowerCase().slice(0, 200)}`,
});

// CSP violation reports (POST /csp-report): browsers send these directly, and
// one bad page load can send dozens. Excess reports are just dropped.
export const cspReportLimiter: RequestHandler = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  prefix: 'csp-report',
  message: 'Too many reports',
  keyGenerator: clientIp,
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