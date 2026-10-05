import pino from 'pino';
import { env } from '../config/env.js';

// pino-http's default req/res serializers attach the FULL header object
// verbatim (confirmed against pino-std-serializers' req/res serializers) —
// without this, every completed request logs the live bearer JWT
// (req.headers.authorization) and refresh cookie (req.headers.cookie on the
// way in, res.headers['set-cookie'] on login/refresh responses on the way
// out) in plaintext. Exported so a test can assert against the exact same
// paths rather than a hand-copied duplicate that could drift.
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact at the root logger so it applies regardless of which
  // middleware/call site produced the log line.
  redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
