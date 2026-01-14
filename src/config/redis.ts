// config/redis.ts

import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

// ============================================================================
// Connection Options for BullMQ (creates its own connections)
// ============================================================================

export const redisConnectionOptions: RedisOptions = {
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword || undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
  connectTimeout: 10000,
  commandTimeout: 30000,
  family: 4,
  keepAlive: 30000,
  retryStrategy: (times: number) => {
    if (times > 20) {
      logger.error(`Redis: Max retries (${times}) reached`);
      return null;
    }
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
};

// ============================================================================
// Shared Redis Instance (Singleton)
// ============================================================================

let redis: Redis | null = null;
let isConnecting = false;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: env.redisHost,
      port: env.redisPort,
      password: env.redisPassword || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: 10000,
      retryStrategy: (times: number) => {
        if (times > 10) return null;
        return Math.min(times * 500, 5000);
      },
    });

    redis.on('connect', () => logger.info('Redis: Connected'));
    redis.on('ready', () => logger.info('Redis: Ready'));
    redis.on('error', (err: Error) => {
      // Suppress connection spam during reconnection
      if (!err.message.includes('ECONNREFUSED')) {
        logger.error('Redis error:', err.message);
      }
    });
    redis.on('close', () => logger.warn('Redis: Connection closed'));
    redis.on('reconnecting', () => logger.debug('Redis: Reconnecting...'));
  }
  return redis;
}

// ============================================================================
// Connection Helpers
// ============================================================================

export async function connectRedis(): Promise<void> {
  if (isConnecting) return;
  
  const client = getRedis();
  if (client.status === 'ready') return;

  isConnecting = true;
  try {
    await client.connect();
  } finally {
    isConnecting = false;
  }
}

export function isRedisReady(): boolean {
  return redis?.status === 'ready';
}

export async function waitForRedis(timeoutMs = 5000): Promise<boolean> {
  const client = getRedis();
  
  if (client.status === 'ready') return true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.off('ready', onReady);
      resolve(false);
    }, timeoutMs);

    const onReady = () => {
      clearTimeout(timeout);
      resolve(true);
    };

    client.once('ready', onReady);

    if (client.status === 'wait') {
      client.connect().catch(() => {
        clearTimeout(timeout);
        resolve(false);
      });
    }
  });
}

// ============================================================================
// Health Checks
// ============================================================================

export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (!redis || redis.status !== 'ready') return false;
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function getRedisMemoryUsage(): Promise<string> {
  try {
    if (!redis || redis.status !== 'ready') return 'disconnected';
    const info = await redis.info('memory');
    const match = info.match(/used_memory_human:(\S+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'error';
  }
}

export async function getRedisClientCount(): Promise<number> {
  try {
    if (!redis || redis.status !== 'ready') return -1;
    const info = await redis.info('clients');
    const match = info.match(/connected_clients:(\d+)/);
    return match ? parseInt(match[1]) : -1;
  } catch {
    return -1;
  }
}

// ============================================================================
// Cleanup
// ============================================================================

export async function cleanBullMQData(): Promise<void> {
  if (env.nodeEnv !== 'development') return;

  try {
    const ready = await waitForRedis(3000);
    if (!ready || !redis) return;

    const keys = await redis.keys('bull:*');
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info(`Cleaned ${keys.length} BullMQ keys`);
    }
  } catch (e) {
    logger.warn('Failed to clean BullMQ data');
  }
}

export async function closeAllConnections(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    redis = null;
  }
  logger.info('Redis: Closed');
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let isShuttingDown = false;
let shutdownHandlersRegistered = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  try {
    const { gracefulShutdown } = await import('../queues');
    await gracefulShutdown();
  } catch {
    // Queues might not be initialized
  }

  await closeAllConnections();
  process.exit(0);
}

export function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGUSR2', () => handleShutdown('SIGUSR2'));

  process.on('uncaughtException', async (err) => {
    logger.error('Uncaught exception:', err);
    await handleShutdown('uncaughtException');
  });
}

// Export for backward compatibility
export { redis };