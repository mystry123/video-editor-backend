import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

const redisOptions: any = {
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false, // Required by BullMQ
  lazyConnect: true, // Don't connect immediately
};



export const redis = new Redis(redisOptions);

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err: Error) => {
  logger.error('Redis connection error:', err);
});
