import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';


export const redis = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false, // Required by BullMQ
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err) => {
  logger.error('Redis connection error:', err);
});
