// queues/index.ts

import { Queue, Worker } from 'bullmq';
import { redisConnectionOptions, getRedisMemoryUsage, getRedisClientCount } from '../config/redis';
import { logger } from '../utils/logger';

// ============================================================================
// Default Job Options
// ============================================================================

const defaultJobOptions = {
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86400, count: 50 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

// ============================================================================
// Queue Registry
// ============================================================================

const queues = new Map<string, Queue>();
const workers: Worker[] = [];
let isShuttingDown = false;
let monitorInterval: NodeJS.Timeout | null = null;

function createQueue(name: string, options: any = {}): Queue {
  if (queues.has(name)) {
    return queues.get(name)!;
  }

  if (isShuttingDown) {
    throw new Error(`Cannot create queue "${name}" during shutdown`);
  }

  const queue = new Queue(name, {
    connection: { ...redisConnectionOptions },
    defaultJobOptions: { ...defaultJobOptions, ...options },
  });

  queue.on('error', (err) => {
    if (!isShuttingDown) {
      logger.error(`Queue [${name}] error:`, err.message);
    }
  });

  queues.set(name, queue);
  return queue;
}

// ============================================================================
// Queue Getters (Lazy Initialization)
// ============================================================================

let _renderQueue: Queue | null = null;
let _transcriptionQueue: Queue | null = null;
let _fileProcessingQueue: Queue | null = null;
let _webhookQueue: Queue | null = null;
let _captionQueue: Queue | null = null;
let _fileImportQueue: Queue | null = null;

export function getRenderQueue(): Queue {
  if (!_renderQueue) {
    _renderQueue = createQueue('render', {
      removeOnComplete: { age: 1800, count: 20 },
    });
  }
  return _renderQueue;
}

export function getTranscriptionQueue(): Queue {
  if (!_transcriptionQueue) {
    _transcriptionQueue = createQueue('transcription', {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10000 },
    });
  }
  return _transcriptionQueue;
}

export function getFileProcessingQueue(): Queue {
  if (!_fileProcessingQueue) {
    _fileProcessingQueue = createQueue('file-processing');
  }
  return _fileProcessingQueue;
}

export function getWebhookQueue(): Queue {
  if (!_webhookQueue) {
    _webhookQueue = createQueue('webhooks', {
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
    });
  }
  return _webhookQueue;
}

export function getCaptionQueue(): Queue {
  if (!_captionQueue) {
    _captionQueue = createQueue('caption', {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 1,
    });
  }
  return _captionQueue;
}

export function getFileImportQueue(): Queue {
  if (!_fileImportQueue) {
    _fileImportQueue = createQueue('file-import', {
      removeOnComplete: true,
      removeOnFail: { age: 86400, count: 20 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
  return _fileImportQueue;
}

// ============================================================================
// Backward Compatible Exports (Proxy Objects)
// ============================================================================

function createQueueProxy(getQueue: () => Queue) {
  return {
    get add() { return getQueue().add.bind(getQueue()); },
    get getJob() { return getQueue().getJob.bind(getQueue()); },
    get close() { return getQueue().close.bind(getQueue()); },
    get getWaitingCount() { return getQueue().getWaitingCount.bind(getQueue()); },
    get getActiveCount() { return getQueue().getActiveCount.bind(getQueue()); },
  };
}

export const renderQueue = createQueueProxy(getRenderQueue);
export const transcriptionQueue = createQueueProxy(getTranscriptionQueue);
export const fileProcessingQueue = createQueueProxy(getFileProcessingQueue);
export const webhookQueue = createQueueProxy(getWebhookQueue);
export const captionQueue = createQueueProxy(getCaptionQueue);
export const fileImportQueue = createQueueProxy(getFileImportQueue);

// ============================================================================
// Worker Management
// ============================================================================

export function registerWorker(worker: Worker): void {
  if (!workers.includes(worker)) {
    workers.push(worker);
  }
}

export function getAllWorkers(): Worker[] {
  return [...workers];
}

// ============================================================================
// Start Workers
// ============================================================================

let workersStarted = false;

export function startWorkers(): void {
  if (workersStarted) {
    logger.warn('Workers already started, skipping...');
    return;
  }

  logger.info('Starting workers...');

  const workerModules = [
    '../workers/render.worker',
    '../workers/transcription.worker',
    '../workers/file.worker',
    '../workers/webhook.worker',
    '../workers/caption.worker',
    '../workers/file-import.worker',
  ];

  let loaded = 0;
  for (const path of workerModules) {
    try {
      require(path);
      loaded++;
    } catch (error: any) {
      logger.error(`Failed to load worker ${path}:`, error.message);
    }
  }

  workersStarted = loaded > 0;
  logger.info(`Workers started: ${loaded}/${workerModules.length}`);

  // Start monitoring
  if (workersStarted && !monitorInterval) {
    monitorInterval = setInterval(async () => {
      try {
        const memory = await getRedisMemoryUsage();
        const clients = await getRedisClientCount();
        logger.debug('Queue monitor', { memory, clients, workers: workers.length });
      } catch {
        // Ignore
      }
    }, 30000);
    monitorInterval.unref();
  }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

export async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down queues...');

  // Stop monitoring
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Close workers with timeout
  const workerPromises = workers.map(async (w) => {
    try {
      await Promise.race([
        w.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
    } catch {
      // Ignore
    }
  });
  await Promise.allSettled(workerPromises);
  workers.length = 0;

  // Close queues with timeout
  const queuePromises = Array.from(queues.values()).map(async (q) => {
    try {
      await Promise.race([
        q.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
    } catch {
      // Ignore
    }
  });
  await Promise.allSettled(queuePromises);
  queues.clear();

  // Reset
  _renderQueue = null;
  _transcriptionQueue = null;
  _fileProcessingQueue = null;
  _webhookQueue = null;
  _captionQueue = null;
  _fileImportQueue = null;
  workersStarted = false;
  isShuttingDown = false;

  logger.info('Queues closed');
}

// ============================================================================
// Utilities
// ============================================================================

export function getAllQueues(): Queue[] {
  return Array.from(queues.values());
}

export function isQueueShuttingDown(): boolean {
  return isShuttingDown;
}

export { workers };