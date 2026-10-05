import { env } from '../../../config/env.js';

/**
 * Best-effort, single-process sliding-window rate limiter — an in-memory
 * Map, not Redis-backed or distributed. That is a deliberate, documented
 * simplification for M14 (see the milestone report): this stack has no
 * shared cache layer anywhere else either, and introducing one purely for
 * this would be over-building for a first AI milestone. It is sufficient
 * to blunt one runaway client; it is not a scaling-safe primitive across
 * multiple backend instances, and must be revisited before that becomes
 * a real deployment shape.
 */
class AiRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Returns true if the request is allowed (and records it); false if the
   * caller has exceeded AI_RATE_LIMIT_PER_USER_PER_HOUR requests in the
   * trailing hour. */
  tryConsume(organisationId: string, userId: string): boolean {
    const key = `${organisationId}:${userId}`;
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (existing.length >= env.AI_RATE_LIMIT_PER_USER_PER_HOUR) {
      this.hits.set(key, existing);
      return false;
    }

    existing.push(now);
    this.hits.set(key, existing);
    return true;
  }
}

export const aiRateLimiter = new AiRateLimiter();
