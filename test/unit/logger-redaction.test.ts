import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from '../../src/lib/logger.js';

/**
 * Builds a fresh pino instance using the SAME redact paths the production
 * logger uses, writing synchronously to an in-memory sink — avoids relying
 * on the production logger's async stdout destination, which isn't
 * reliably interceptable in a unit test.
 */
function loggerWithCapture() {
  const lines: string[] = [];
  const sink = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  const testLogger = pino(
    { redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' } },
    sink as unknown as NodeJS.WritableStream,
  );
  return { testLogger, lines };
}

describe('logger redaction', () => {
  it('redacts the Authorization header, the request Cookie header, and the Set-Cookie response header', () => {
    const { testLogger, lines } = loggerWithCapture();
    const secretJwt = 'Bearer super-secret-access-token-value';
    const secretCookie = 'refreshToken=super-secret-refresh-value; Path=/api/v1/auth';

    // Shaped exactly like pino-http's actual req/res serializers (verified
    // against pino-std-serializers): req.headers is the raw incoming
    // headers object, res.headers is res.getHeaders().
    testLogger.info(
      {
        req: {
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            authorization: secretJwt,
            cookie: secretCookie,
            'content-type': 'application/json',
          },
        },
        res: { statusCode: 200, headers: { 'set-cookie': secretCookie } },
      },
      'request completed',
    );

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]);
    expect(logged.req.headers.authorization).toBe('[Redacted]');
    expect(logged.req.headers.cookie).toBe('[Redacted]');
    expect(logged.res.headers['set-cookie']).toBe('[Redacted]');
    // Nothing secret leaked anywhere else in the line either.
    expect(lines[0]).not.toContain('super-secret-access-token-value');
    expect(lines[0]).not.toContain('super-secret-refresh-value');
    // Unrelated fields are untouched.
    expect(logged.req.headers['content-type']).toBe('application/json');
    expect(logged.req.url).toBe('/api/v1/auth/login');
  });
});
