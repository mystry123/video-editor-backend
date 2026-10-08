import pino from 'pino';
import { env } from '../config/env';

// Field names that must never reach the logs, at the top level or one/two
// levels deep (e.g. { headers: { authorization } }, { user: { password } }).
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'newPassword',
  'currentPassword',
  'accessToken',
  'refreshToken',
  'refreshTokens',
  'token',
  'idToken',
  'apiKey',
  'secret',
  'mongodbUri',
  'uri',
];
const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => {
  const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const dot = k.startsWith('[') ? '' : '.';
  return [k, `*${dot}${k}`, `*.*${dot}${k}`];
});

export const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  hooks: {
    // The codebase calls logger.info('message', { context }) (winston order).
    // pino expects (context, message) and would silently drop the context,
    // so swap them here instead of rewriting every call site.
    logMethod(args, method) {
      if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        const [message, context, ...rest] = args as [string, object, ...unknown[]];
        const merged = context instanceof Error ? { err: context } : context;
        return method.apply(this, [merged, message, ...rest] as any);
      }
      return method.apply(this, args as any);
    },
  },
  transport: env.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss Z' } }
    : undefined,
});
