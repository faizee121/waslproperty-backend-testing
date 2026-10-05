import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/lib/tokens.js';

describe('access tokens', () => {
  it('round-trips claims through sign and verify', () => {
    const token = signAccessToken({
      sub: 'user_1',
      sessionType: 'CUSTOMER',
      organisationId: 'org_1',
      orgRole: 'OWNER',
    });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('user_1');
    expect(payload.organisationId).toBe('org_1');
    expect(payload.orgRole).toBe('OWNER');
  });

  it('throws on a tampered token', () => {
    const token = signAccessToken({
      sub: 'user_1',
      sessionType: 'CUSTOMER',
      organisationId: 'org_1',
      orgRole: 'OWNER',
    });
    expect(() => verifyAccessToken(`${token}tampered`)).toThrow();
  });
});

describe('refresh tokens', () => {
  it('generates unique high-entropy tokens', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(64);
  });

  it('hashes deterministically for lookup', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toEqual(hashRefreshToken(token));
  });
});
