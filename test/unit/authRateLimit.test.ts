import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * authRateLimit.ts's exported limiters are deliberately inert during
 * NODE_ENV=test (see its own doc comment) so the rest of the integration
 * suite isn't throttled against itself. That means the actual throttling
 * BEHAVIOUR has to be verified against a limiter built with the same
 * options minus the test skip, on a tiny standalone app — this is that
 * test, not a test of the production singletons directly.
 */
function buildAppWithLimiter(limit: number) {
  const app = express();
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many login attempts.' } },
    }),
  );
  app.post('/login', (_req, res) => res.status(401).json({ error: { message: 'bad creds' } }));
  return app;
}

describe('auth rate limiting', () => {
  it('allows requests up to the limit, then rejects further requests from the same client with 429', async () => {
    const app = buildAppWithLimiter(3);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/login').send({});
      expect(res.status).toBe(401); // the limiter lets it through to the real handler
    }

    const blocked = await request(app).post('/login').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('responds with the configured RateLimit-* headers so a well-behaved client can back off', async () => {
    const app = buildAppWithLimiter(5);
    const res = await request(app).post('/login').send({});
    expect(res.status).toBe(401);
    expect(res.headers).toHaveProperty('ratelimit-limit');
    expect(res.headers).toHaveProperty('ratelimit-remaining');
  });
});
