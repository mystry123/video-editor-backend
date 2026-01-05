import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../config/redis';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-ignore - types mismatch but works
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  message: { error: 'Too many requests, please try again later in 1 minute' },
});

export const renderLimiter = rateLimit({
  windowMs:  60 * 1000, // 1 minute
  max: 100, // 1000 renders per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-ignore
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: { error: 'Render limit exceeded, please try again later in 1 hour' },
});

export const progressLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 progress checks per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-ignore
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: { error: 'Progress check limit exceeded, please try again later' },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-ignore
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  message: { error: 'Upload limit exceeded, please try again later in 1 hour' },
});
