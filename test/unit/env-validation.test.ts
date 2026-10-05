import { describe, expect, it } from 'vitest';
import { envValidationSchema } from '../../src/config/env.js';

// Only the fields with no default/optional() need to be supplied for a
// base-valid object; every test below overrides just what it's testing.
const validBase = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  AWS_REGION: 'ap-southeast-2',
  S3_BUCKET_NAME: 'wasl-test-bucket',
};

describe('env validation', () => {
  describe('in production', () => {
    const prod = { ...validBase, NODE_ENV: 'production', COOKIE_SECURE: 'true' };

    it('accepts a strong secret and secure cookie config', () => {
      const result = envValidationSchema.safeParse(prod);
      expect(result.success).toBe(true);
    });

    it('rejects the literal .env.example placeholder secrets', () => {
      const result = envValidationSchema.safeParse({
        ...prod,
        JWT_ACCESS_SECRET: 'change_me_access',
        JWT_REFRESH_SECRET: 'change_me_refresh',
      });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('JWT_ACCESS_SECRET');
      expect(paths).toContain('JWT_REFRESH_SECRET');
    });

    it('rejects a secret shorter than the minimum production length', () => {
      const result = envValidationSchema.safeParse({
        ...prod,
        JWT_ACCESS_SECRET: 'too-short',
      });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('JWT_ACCESS_SECRET');
    });

    it('rejects COOKIE_SECURE=false', () => {
      const result = envValidationSchema.safeParse({ ...prod, COOKIE_SECURE: 'false' });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('COOKIE_SECURE');
    });
  });

  describe('in development', () => {
    it('still accepts the .env.example placeholder secrets and insecure cookies, so local setup keeps working', () => {
      const result = envValidationSchema.safeParse({
        ...validBase,
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: 'change_me_access',
        JWT_REFRESH_SECRET: 'change_me_refresh',
        COOKIE_SECURE: 'false',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('in test', () => {
    it("accepts short, fixed, non-placeholder test secrets (this is .env.test's actual shape)", () => {
      const result = envValidationSchema.safeParse({
        ...validBase,
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test_access_secret',
        JWT_REFRESH_SECRET: 'test_refresh_secret',
        COOKIE_SECURE: 'false',
      });
      expect(result.success).toBe(true);
    });

    it('still rejects the literal placeholder values outside development', () => {
      const result = envValidationSchema.safeParse({
        ...validBase,
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'change_me_access',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('cookie SameSite/Secure combination, independent of NODE_ENV', () => {
    it('rejects SameSite=none without Secure=true', () => {
      const result = envValidationSchema.safeParse({
        ...validBase,
        NODE_ENV: 'development',
        COOKIE_SAME_SITE: 'none',
        COOKIE_SECURE: 'false',
      });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('COOKIE_SAME_SITE');
    });

    it('allows the legitimate cross-origin staging/prod combination (SameSite=none + Secure=true)', () => {
      const result = envValidationSchema.safeParse({
        ...validBase,
        NODE_ENV: 'production',
        COOKIE_SAME_SITE: 'none',
        COOKIE_SECURE: 'true',
      });
      expect(result.success).toBe(true);
    });
  });
});
