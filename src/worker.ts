// src/worker.ts
//
// The background worker process: renders, captions, transcription, reframe,
// imports, webhooks and account cleanup. Runs separately from the API (pm2
// app "shotline-worker") so deploying or restarting the API never interrupts
// a job, and heavy media work doesn't slow down requests.
//
// On SIGTERM/SIGINT it stops taking new jobs and waits up to
// WORKER_DRAIN_TIMEOUT_MS (default 10 min) for active ones to finish. Set
// pm2's kill_timeout a little above that.

import mongoose from 'mongoose';
import { startWorkers, gracefulShutdown } from './queues';
import { closeAllConnections } from './config/redis';
import { checkMediaTools, initCore, initRedis } from './bootstrap';
import { logger } from './utils/logger';

const DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MS) || 10 * 60 * 1000;
const REDIS_WAIT_MS = 30_000;

let shuttingDown = false;

async function start(): Promise<void> {
  logger.info('🛠️ Starting worker process...');
  await initCore();

  // Workers can't do anything without Redis. Exit so pm2 restarts us with backoff.
  if (!(await initRedis(REDIS_WAIT_MS))) {
    logger.error(`❌ Redis not reachable after ${REDIS_WAIT_MS / 1000}s; exiting so the process manager retries`);
    process.exit(1);
  }

  checkMediaTools();
  startWorkers();
  logger.info('✅ Worker process ready');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`⚠️ ${signal}: no new jobs; waiting up to ${Math.round(DRAIN_TIMEOUT_MS / 1000)}s for active jobs`);

  // Last resort if something hangs past the drain window.
  const force = setTimeout(() => {
    logger.error('❌ Worker shutdown timed out; exiting');
    process.exit(1);
  }, DRAIN_TIMEOUT_MS + 30_000);
  force.unref();

  try {
    await gracefulShutdown({ workerDrainMs: DRAIN_TIMEOUT_MS });
    await closeAllConnections().catch(() => undefined);
    await mongoose.connection.close().catch(() => undefined);
    logger.info('🎉 Worker process stopped cleanly');
    process.exit(0);
  } catch (error: any) {
    logger.error('❌ Worker shutdown error', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  if (!shuttingDown) logger.error('❌ Unhandled rejection in worker', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught exception in worker', { error: error.message, stack: error.stack });
  void shutdown('uncaughtException');
});

start().catch((error) => {
  logger.error('❌ Worker failed to start', { error: error.message });
  process.exit(1);
});
