import 'dotenv/config';
import app from './app';
import { connectDatabase } from './config/database';
import { startWorkers } from './queues';
import { logger } from './utils/logger';
import { env } from './config/env';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function bootstrap(): Promise<void> {
  // Connect to MongoDB
  await connectDatabase();

  // Start background workers (can be separate process in production)
  if (process.env.ENABLE_WORKERS !== 'false') {
    startWorkers();
  }

  // Start server
  const server = app.listen(env.port, () => {
    logger.info(`🚀 Server running on port ${env.port}`);
    logger.info(`📝 Environment: ${env.nodeEnv}`);
    logger.info(`🔗 Health check: http://localhost:${env.port}/health`);
  });

  server.on('error', (err: any) => {
    logger.error('Server error:', err);
    throw err;
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server - FULL ERROR:', err);
  logger.error('Failed to start server:', err);
  process.exit(1);
});
