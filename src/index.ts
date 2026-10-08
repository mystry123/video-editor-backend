// src/index.ts

import http from 'http';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import app from './app';
import { startWorkers, gracefulShutdown } from './queues';
import { closeAllConnections, isRedisReady, onRedisReady } from './config/redis';
import { checkMediaTools, initCore, initRedis } from './bootstrap';
import { logger } from './utils/logger';
import { env } from './config/env';

// Load environment variables from project root
dotenv.config();

let server: http.Server;
let isShuttingDown = false;

// ============================================================================
// Global Error Handlers (must be registered early)
// ============================================================================

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  console.error('Uncaught Exception - FULL ERROR:', error);
  handleShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  // Don't spam logs during shutdown
  if (isShuttingDown) return;

  console.error('❌ Unhandled Rejection - RAW DATA:');
  console.error('Reason:', reason);

  if (reason instanceof Error) {
    console.error('Error message:', reason.message);
    console.error('Stack trace:', reason.stack);
    logger.error('❌ Unhandled Rejection:', reason.message);
  } else {
    console.error('Reason type:', typeof reason);
    logger.error('❌ Unhandled Rejection:', reason);
  }

  // Don't shutdown for unhandled rejections, just log
});

// ============================================================================
// Bootstrap Application
// ============================================================================

async function bootstrap(): Promise<void> {
  const startTime = Date.now();
  logger.info('🚀 Starting application...');

  try {
    // Steps 1-2: MongoDB, quotas, plans
    await initCore();

    // Step 3: Redis (with graceful fallback)
    const redisHealthy = await initRedis(5000);

    if (!redisHealthy) {
      if (env.nodeEnv === 'development') {
        logger.warn('⚠️ Redis not available - running without Redis');
        logger.warn('⚠️ Rate limiting will use memory store');
        logger.warn('⚠️ Workers/queues disabled');
      } else {
        // In production, we still continue but with warnings
        logger.error('⚠️ Redis not available in production - some features limited');
      }
    } else {
      logger.info('✅ Redis connected');
    }

    // =========================================================================
    // Step 4: Start HTTP Server
    // =========================================================================
    server = app.listen(env.port, () => {
      logger.info(`🚀 Server running on port ${env.port}`);
      logger.info(`📝 Environment: ${env.nodeEnv}`);
      logger.info(`🔗 Health check: http://localhost:${env.port}/health`);
    });

    // Configure server timeouts
    server.timeout = 120000; // 2 minutes
    server.keepAliveTimeout = 65000; // Slightly higher than ALB's 60s
    server.headersTimeout = 66000;

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${env.port} is already in use`);
        process.exit(1);
      }
      logger.error('❌ Server error:', err);
    });

    checkMediaTools();

    // =========================================================================
    // Step 5: Start Workers (only if Redis is available)
    // =========================================================================
    if (process.env.ENABLE_WORKERS !== 'false' && redisHealthy) {
      // Small delay to ensure server is fully ready
      setTimeout(() => {
        try {
          startWorkers();
          logger.info('✅ Workers started');
        } catch (error: any) {
          logger.error('❌ Failed to start workers:', error.message);
        }
      }, 1000);
    } else if (!redisHealthy && process.env.ENABLE_WORKERS !== 'false') {
      // Start them as soon as Redis comes up instead of never.
      logger.warn('⚠️ Redis not available yet - workers will start when it connects');
      onRedisReady(() => {
        try {
          startWorkers();
          logger.info('✅ Workers started (Redis became available)');
        } catch (error: any) {
          logger.error('❌ Failed to start workers:', error.message);
        }
      });
    } else {
      logger.info('ℹ️ Workers disabled by ENABLE_WORKERS=false');
    }

    // =========================================================================
    // Done!
    // =========================================================================
    const duration = Date.now() - startTime;
    logger.info(`✅ Application ready in ${duration}ms`);

  } catch (error: any) {
    logger.error('❌ Bootstrap failed:', error);
    throw error;
  }
}

// ============================================================================
// Graceful Shutdown Handler
// ============================================================================

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn(`Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info(`\n⚠️ Received ${signal}, starting graceful shutdown...`);

  // Force exit after 30 seconds
  const forceExitTimeout = setTimeout(() => {
    logger.error('❌ Graceful shutdown timeout (30s), forcing exit');
    process.exit(1);
  }, 30000);

  try {
    // 1. Stop accepting new HTTP connections
    if (server) {
      logger.info('⏳ Closing HTTP server...');
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) {
            logger.warn('HTTP server close warning:', err.message);
          }
          logger.info('✅ HTTP server closed');
          resolve();
        });

        // Force close after 10 seconds
        setTimeout(() => {
          logger.warn('⚠️ Forcing HTTP server close');
          resolve();
        }, 10000);
      });
    }

    // 2. Gracefully shutdown queues and workers
    if (isRedisReady()) {
      logger.info('⏳ Closing workers and queues...');
      try {
        await Promise.race([
          gracefulShutdown(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Queue shutdown timeout')), 10000)
          ),
        ]);
        logger.info('✅ Workers and queues closed');
      } catch (error: any) {
        logger.warn('⚠️ Queue shutdown warning:', error.message);
      }
    }

    // 3. Close Redis connections
    logger.info('⏳ Closing Redis connections...');
    try {
      await closeAllConnections();
      logger.info('✅ Redis connections closed');
    } catch (error: any) {
      logger.warn('⚠️ Redis close warning:', error.message);
    }

    // 4. Close MongoDB connection
    logger.info('⏳ Closing MongoDB connection...');
    try {
      await mongoose.connection.close();
      logger.info('✅ MongoDB connection closed');
    } catch (error: any) {
      logger.warn('⚠️ MongoDB close warning:', error.message);
    }

    clearTimeout(forceExitTimeout);
    logger.info('🎉 Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Shutdown error:', error);
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// ============================================================================
// Register Shutdown Handlers
// ============================================================================

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGUSR2', () => handleShutdown('SIGUSR2')); // nodemon/tsx

// ============================================================================
// Start Application
// ============================================================================

bootstrap().catch((err) => {
  logger.error('❌ Failed to start server:', err);
  console.error('Failed to start server - FULL ERROR:', err);
  process.exit(1);
});