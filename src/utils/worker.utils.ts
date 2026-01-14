// workers/worker.utils.ts

import { Worker, Job, WorkerOptions } from 'bullmq';
import { redisConnectionOptions } from '../config/redis';
import { registerWorker, isQueueShuttingDown } from '../queues';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface CreateWorkerConfig<T = any, R = any> {
  name: string;
  processor: (job: Job<T>) => Promise<R>;
  concurrency?: number;
  lockDuration?: number;
  options?: Partial<WorkerOptions>;
}

// ============================================================================
// Error Tracking (to prevent log spam)
// ============================================================================

const errorTracker = new Map<string, { count: number; lastLogged: number }>();
const ERROR_LOG_INTERVAL = 30000; // Only log same error type once per 30 seconds

function shouldLogError(workerName: string, errorType: string): boolean {
  const key = `${workerName}:${errorType}`;
  const now = Date.now();
  const tracked = errorTracker.get(key);

  if (!tracked || now - tracked.lastLogged > ERROR_LOG_INTERVAL) {
    errorTracker.set(key, { count: 1, lastLogged: now });
    return true;
  }

  tracked.count++;
  return false;
}

function isConnectionError(err: Error): boolean {
  const connectionErrors = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'Connection is closed',
    'Connection closed',
    'Stream isn\'t writeable',
    'getaddrinfo',
    'connect ECONNREFUSED',
    'read ECONNRESET',
    'socket hang up',
    'ENOENT',
    'Redis connection',
    'ERR max number of clients',
  ];

  return connectionErrors.some((e) => err.message?.includes(e));
}

// ============================================================================
// Create Worker with Robust Error Handling
// ============================================================================

export function createWorker<T = any, R = any>(config: CreateWorkerConfig<T, R>): Worker<T, R> {
  const {
    name,
    processor,
    concurrency = 5,
    lockDuration = 60000,
    options = {},
  } = config;

  if (isQueueShuttingDown()) {
    throw new Error(`Cannot create worker "${name}" during shutdown`);
  }

  const worker = new Worker<T, R>(
    name,
    async (job: Job<T>) => {
      const startTime = Date.now();
      try {
        return await processor(job);
      } finally {
        const duration = Date.now() - startTime;
        logger.debug(`[${name}] Job ${job.id} took ${duration}ms`);
      }
    },
    {
      connection: { ...redisConnectionOptions },
      concurrency,
      lockDuration,
      lockRenewTime: Math.floor(lockDuration / 2),
      ...options,
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    logger.info(`[${name}] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    // Don't log connection errors as job failures
    if (!isConnectionError(err)) {
      logger.error(`[${name}] Job ${job?.id || 'unknown'} failed: ${err.message}`);
    }
  });

  worker.on('error', (err) => {
    // Skip logging during shutdown
    if (isQueueShuttingDown()) return;

    // For connection errors, only log once per interval to prevent spam
    if (isConnectionError(err)) {
      if (shouldLogError(name, 'connection')) {
        logger.warn(`[${name}] Connection error (will retry): ${err.message}`);
      }
      return;
    }

    // For Lua script errors, log but don't crash
    if (err.message?.includes('Error compiling script') || err.message?.includes('unexpected symbol')) {
      if (shouldLogError(name, 'lua_script')) {
        logger.warn(`[${name}] Lua script error (non-critical): ${err.message}`);
      }
      return;
    }

    // For other errors, log with rate limiting
    if (shouldLogError(name, err.message)) {
      logger.error(`[${name}] Worker error: ${err.message}`);
    }
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`[${name}] Job ${jobId} stalled`);
  });

  // Register for graceful shutdown
  registerWorker(worker);
  logger.info(`[${name}] Worker ready (concurrency: ${concurrency})`);

  return worker;
}

// ============================================================================
// Job Logger Helper
// ============================================================================

export function createJobLogger(prefix: string, id: string) {
  const shortId = id.slice(-6);
  return {
    info: (msg: string) => logger.info(`[${prefix}:${shortId}] ${msg}`),
    warn: (msg: string) => logger.warn(`[${prefix}:${shortId}] ${msg}`),
    error: (msg: string) => logger.error(`[${prefix}:${shortId}] ${msg}`),
    debug: (msg: string) => logger.debug(`[${prefix}:${shortId}] ${msg}`),
  };
}

// ============================================================================
// Sleep Utility
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Retry with Backoff
// ============================================================================

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 30000, onRetry } = options;

  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt === maxRetries) break;
      if (onRetry) onRetry(error, attempt);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw lastError!;
}