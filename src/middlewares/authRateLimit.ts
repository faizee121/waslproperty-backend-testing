import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Anti-brute-force throttling for the two sensitive, unauthenticated auth
 * endpoints. argon2 already makes each password check slow, but nothing
 * previously bounded HOW MANY attempts a single client could make — see
 * the engineering audit's auth/session finding. Keyed by client IP
 * (express-rate-limit's default keyGenerator, IPv6-safe) — correct only
 * once `trust proxy` is configured for the real deployment topology, see
 * app.ts. Refresh is deliberately NOT given the same treatment here: its
 * token is a 384-bit random value (see lib/tokens.ts), not a password —
 * brute-forcing it is computationally infeasible, so the same "slow down
 * guessing" rationale doesn't apply.
 *
 * Disabled during automated tests (`skip`) — the integration suite calls
 * register/login hundreds of times across files sharing one process/IP,
 * which would otherwise make the suite itself look like the exact attack
 * this exists to stop. The rate-limiting behaviour itself is covered by
 * test/unit/authRateLimit.test.ts against a limiter built with the same
 * options but without this skip.
 */
const skipInTest = () => env.NODE_ENV === 'test';

export function createLoginRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
    message: {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many login attempts. Please wait a few minutes and try again.',
      },
    },
  });
}

export function createRegisterRateLimiter() {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
    message: {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many registration attempts. Please wait a while and try again.',
      },
    },
  });
}

export const loginRateLimiter = createLoginRateLimiter();
export const registerRateLimiter = createRegisterRateLimiter();
