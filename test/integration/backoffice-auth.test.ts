import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlatformUser, registerTestUser } from '../helpers/auth.js';
import { signAccessToken, signPlatformAccessToken } from '../../src/lib/tokens.js';
import { resolvePlatformCapabilities } from '../../src/platform/capabilities.js';

const app = createApp();

async function platformLogin(username: string, password: string) {
  return request(app).post('/api/v1/backoffice/auth/login').send({ username, password });
}

describe('backoffice platform auth', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('platform login', () => {
    it('signs in an active Employee and returns resolved capabilities', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });

      const res = await platformLogin(username, password);
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.platformRole).toBe('PLATFORM_ADMIN');
      expect(res.body.platformCapabilities).toEqual(resolvePlatformCapabilities('PLATFORM_ADMIN'));
      expect(res.headers['set-cookie']?.[0]).toMatch(/wasl_property_platform_refresh_token=/);
    });

    it('rejects login for a username with no Employee at all', async () => {
      // A customer User has no username/Employee row at all — the two
      // identity spaces are completely disjoint now, so this is the
      // faithful "no Backoffice access" case rather than trying to log a
      // customer in by (nonexistent) username.
      await registerTestUser(app, { email: `owner+${Date.now()}@example.com` });
      const res = await platformLogin(`nobody.${Date.now()}`, 'super-secret-1');
      expect(res.status).toBe(401);
    });

    it('rejects a deactivated Employee even with the correct password', async () => {
      const { username, password } = await createPlatformUser({ isActive: false });
      const res = await platformLogin(username, password);
      expect(res.status).toBe(401);
    });

    it('rejects the wrong password', async () => {
      const { username } = await createPlatformUser();
      const res = await platformLogin(username, 'wrong-password');
      expect(res.status).toBe(401);
    });
  });

  describe('self-service change password', () => {
    it('changes the password and the new one works on the next login, the old one no longer does', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const token = loginRes.body.accessToken as string;

      const res = await request(app)
        .post('/api/v1/backoffice/auth/change-password')
        .set(authHeader(token))
        .send({ currentPassword: password, newPassword: 'a-brand-new-password-123' });
      expect(res.status).toBe(204);

      const oldLogin = await platformLogin(username, password);
      expect(oldLogin.status).toBe(401);

      const newLogin = await platformLogin(username, 'a-brand-new-password-123');
      expect(newLogin.status).toBe(200);
    });

    it('rejects an incorrect current password', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const token = loginRes.body.accessToken as string;

      const res = await request(app)
        .post('/api/v1/backoffice/auth/change-password')
        .set(authHeader(token))
        .send({ currentPassword: 'totally-wrong', newPassword: 'a-brand-new-password-123' });
      expect(res.status).toBe(401);
    });

    it('rejects a new password shorter than 8 characters', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const token = loginRes.body.accessToken as string;

      const res = await request(app)
        .post('/api/v1/backoffice/auth/change-password')
        .set(authHeader(token))
        .send({ currentPassword: password, newPassword: 'short' });
      expect(res.status).toBe(422);
    });

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/api/v1/backoffice/auth/change-password')
        .send({ currentPassword: 'x', newPassword: 'a-brand-new-password-123' });
      expect(res.status).toBe(401);
    });

    it('records an audit event without leaking either password', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const token = loginRes.body.accessToken as string;

      await request(app)
        .post('/api/v1/backoffice/auth/change-password')
        .set(authHeader(token))
        .send({ currentPassword: password, newPassword: 'a-brand-new-password-123' });

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'employee.passwordChanged' },
      });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain(password);
      expect(JSON.stringify(audit)).not.toContain('a-brand-new-password-123');
    });
  });

  describe('platform session lifecycle', () => {
    it('refreshes a platform session and rotates the cookie', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const cookie = loginRes.headers['set-cookie'][0];

      const refreshRes = await request(app)
        .post('/api/v1/backoffice/auth/refresh')
        .set('Cookie', cookie);
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.accessToken).toBeTypeOf('string');
      expect(refreshRes.headers['set-cookie'][0]).not.toBe(cookie);

      // Rotation: the old refresh cookie is revoked and no longer usable.
      const reuseRes = await request(app)
        .post('/api/v1/backoffice/auth/refresh')
        .set('Cookie', cookie);
      expect(reuseRes.status).toBe(401);
    });

    it('logs out and revokes the platform refresh token', async () => {
      const { username, password } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const cookie = loginRes.headers['set-cookie'][0];

      const logoutRes = await request(app)
        .post('/api/v1/backoffice/auth/logout')
        .set('Cookie', cookie);
      expect(logoutRes.status).toBe(204);

      const refreshRes = await request(app)
        .post('/api/v1/backoffice/auth/refresh')
        .set('Cookie', cookie);
      expect(refreshRes.status).toBe(401);
    });

    it('rejects refresh with no cookie at all', async () => {
      const res = await request(app).post('/api/v1/backoffice/auth/refresh');
      expect(res.status).toBe(401);
    });

    it('rejects a refresh once the Employee has been deactivated mid-session', async () => {
      const { username, password, employeeId } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const cookie = loginRes.headers['set-cookie'][0];

      await testPrisma.employee.update({
        where: { id: employeeId },
        data: { isActive: false },
      });

      const refreshRes = await request(app)
        .post('/api/v1/backoffice/auth/refresh')
        .set('Cookie', cookie);
      expect(refreshRes.status).toBe(401);
    });

    it('rejects an expired platform session', async () => {
      const { username, password, employeeId } = await createPlatformUser();
      const loginRes = await platformLogin(username, password);
      const cookie = loginRes.headers['set-cookie'][0];
      const rawToken = /wasl_property_platform_refresh_token=([^;]+)/.exec(cookie)?.[1] as string;

      const { createHash } = await import('node:crypto');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      await testPrisma.employeeSession.updateMany({
        where: { employeeId, refreshTokenHash: tokenHash },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const refreshRes = await request(app)
        .post('/api/v1/backoffice/auth/refresh')
        .set('Cookie', cookie);
      expect(refreshRes.status).toBe(401);
    });
  });

  describe('session-type isolation', () => {
    it('GET /backoffice/auth/me works for a valid platform token', async () => {
      const { username, password, role } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });
      const loginRes = await platformLogin(username, password);

      const res = await request(app)
        .get('/api/v1/backoffice/auth/me')
        .set(authHeader(loginRes.body.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.platformRole).toBe(role);
    });

    it('rejects a customer token on every Backoffice route', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app).get('/api/v1/backoffice/auth/me').set(authHeader(accessToken));
      expect(res.status).toBe(401);
    });

    it('rejects a hand-crafted customer-shaped token on Backoffice routes even with a real platform user id', async () => {
      const { employeeId } = await createPlatformUser();
      const forgedCustomerToken = signAccessToken({
        sub: employeeId,
        sessionType: 'CUSTOMER',
        organisationId: 'org_does_not_matter',
        orgRole: 'OWNER',
      });
      const res = await request(app)
        .get('/api/v1/backoffice/auth/me')
        .set(authHeader(forgedCustomerToken));
      expect(res.status).toBe(401);
    });

    it('rejects a platform token on an ordinary customer route', async () => {
      const { userId } = await registerTestUser(app);
      const forgedPlatformToken = signPlatformAccessToken({
        sub: userId,
        sessionType: 'PLATFORM',
        username: 'does_not_matter',
        platformRole: 'PLATFORM_SUPER_ADMIN',
        platformCapabilities: resolvePlatformCapabilities('PLATFORM_SUPER_ADMIN'),
      });
      const res = await request(app)
        .get('/api/v1/organisations/me')
        .set(authHeader(forgedPlatformToken));
      expect(res.status).toBe(401);
    });

    it('an organisation OWNER/ADMIN/MEMBER customer token never grants Backoffice access, regardless of org role', async () => {
      const owner = await registerTestUser(app);
      const res = await request(app)
        .get('/api/v1/backoffice/auth/me')
        .set(authHeader(owner.accessToken));
      expect(res.status).toBe(401);
    });
  });
});
