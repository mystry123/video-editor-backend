import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.logLevel,
  transport: env.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss Z' } }
    : undefined,
});
