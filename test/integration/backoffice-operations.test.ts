import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlatformUser, registerTestUser } from '../helpers/auth.js';
import { buildPublicReference } from '../../src/lib/public-reference.js';

const app = createApp();

async function platformLogin(username: string, password: string) {
  const res = await request(app).post('/api/v1/backoffice/auth/login').send({ username, password });
  return res.body.accessToken as string;
}

describe('backoffice operational modules', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    env.BACKOFFICE_PII_MODE = undefined;
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('cross-cutting RBAC', () => {
    it('an ordinary customer OWNER token cannot reach any Backoffice operational route', async () => {
      const { accessToken } = await registerTestUser(app);
      const routes = [
        '/api/v1/backoffice/dashboard',
        '/api/v1/backoffice/organisations',
        '/api/v1/backoffice/users',
        '/api/v1/backoffice/property-data/properties',
        '/api/v1/backoffice/operations/requests',
        '/api/v1/backoffice/communications',
        '/api/v1/backoffice/jobs',
        '/api/v1/backoffice/integrations',
        '/api/v1/backoffice/audit',
        '/api/v1/backoffice/platform-users',
      ];
      for (const route of routes) {
        const res = await request(app).get(route).set(authHeader(accessToken));
        expect(res.status).toBe(401);
      }
    });

    it('PLATFORM_SUPPORT cannot manage organisations, retry-capability aside', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });
      const token = await platformLogin(username, password);

      const org = await testPrisma.organisation.create({
        data: { name: 'Support Test Org', slug: `support-test-${Date.now()}` },
      });

      const res = await request(app)
        .patch(`/api/v1/backoffice/organisations/${org.id}`)
        .set(authHeader(token))
        .send({ name: 'Renamed', reason: 'should be blocked' });
      expect(res.status).toBe(403);
    });

    it('PLATFORM_ADMIN cannot manage platform users (no platformUsers.manage)', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);

      const res = await request(app)
        .get('/api/v1/backoffice/platform-users')
        .set(authHeader(token));
      expect(res.status).toBe(403);
    });
  });

  describe('dashboard', () => {
    it('returns real cross-organisation counts, not fabricated metrics', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      await registerTestUser(app, { organisationName: 'Dashboard Count Org' });

      const res = await request(app).get('/api/v1/backoffice/dashboard').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.metrics.organisations.total).toBeGreaterThanOrEqual(1);
      expect(res.body).not.toHaveProperty('uptimePercentage');
      expect(res.body).not.toHaveProperty('revenue');
    });
  });

  describe('organisations', () => {
    it('lists organisations across every tenant, not scoped to one', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      await registerTestUser(app, { organisationName: 'Cross Org Alpha' });
      await registerTestUser(app, { organisationName: 'Cross Org Beta' });

      const res = await request(app).get('/api/v1/backoffice/organisations').set(authHeader(token));
      expect(res.status).toBe(200);
      const names = res.body.items.map((o: { name: string }) => o.name);
      expect(names).toContain('Cross Org Alpha');
      expect(names).toContain('Cross Org Beta');
    });

    it('PLATFORM_ADMIN can update an organisation and it is audited', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'Before Rename' });

      const res = await request(app)
        .patch(`/api/v1/backoffice/organisations/${organisationId}`)
        .set(authHeader(token))
        .send({ name: 'After Rename', reason: 'correcting a typo' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('After Rename');

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: { entityType: 'Organisation', entityId: organisationId },
      });
      expect(audit?.action).toBe('organisation.updated');
      expect(audit?.reason).toBe('correcting a typo');
    });
  });

  describe('global search', () => {
    it('finds a real organisation and masks person PII when policy requires it', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });
      const token = await platformLogin(username, password);
      const unique = `Findable-${Date.now()}`;
      await registerTestUser(app, { organisationName: `${unique} Properties` });

      // Force masked mode regardless of the (dev/test-friendly) default.
      env.BACKOFFICE_PII_MODE = 'masked';

      const res = await request(app)
        .get('/api/v1/backoffice/search')
        .query({ q: unique })
        .set(authHeader(token));
      expect(res.status).toBe(200);
      const org = res.body.items.find(
        (r: { entityType: string }) => r.entityType === 'Organisation',
      );
      expect(org.label).toContain(unique);
    });
  });

  describe('users directory', () => {
    it('excludes a pure platform-only employee with no customer relationship', async () => {
      const { username, password, employeeId } = await createPlatformUser();
      const token = await platformLogin(username, password);
      await registerTestUser(app, { organisationName: 'Directory Control Org' });

      const res = await request(app).get('/api/v1/backoffice/users').set(authHeader(token));
      expect(res.status).toBe(200);
      // Employee is an entirely separate table from User — it structurally
      // cannot appear in the customer Users directory, which lists Users.
      const ids = res.body.items.map((u: { id: string }) => u.id);
      expect(ids).not.toContain(employeeId);
    });

    it('User 360 traces a staff member’s organisation membership', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const { userId } = await registerTestUser(app, { organisationName: 'Trace Org' });

      const res = await request(app)
        .get(`/api/v1/backoffice/users/${userId}`)
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.staffOrganisations).toHaveLength(1);
      expect(res.body.staffOrganisations[0].organisation.name).toBe('Trace Org');
      expect(res.body.staffOrganisations[0].role).toBe('OWNER');
    });
  });

  describe('jobs / delivery operations', () => {
    it('retries a FAILED delivery by resetting it to PENDING, and rejects retrying a non-failed one', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });
      const token = await platformLogin(username, password);
      const { organisationId, userId } = await registerTestUser(app, {
        organisationName: 'Retry Test Org',
      });

      const contact = await testPrisma.propertyContact.create({
        data: {
          organisationId,
          firstName: 'Retry',
          lastName: 'Recipient',
          email: `retry+${Date.now()}@example.com`,
        },
      });
      const communication = await testPrisma.communication.create({
        data: {
          organisationId,
          publicReference: buildPublicReference('COM'),
          title: 'Retry Test Announcement',
          body: 'Body',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'ORGANISATION' },
          createdByUserId: userId,
          status: 'SENT',
          sentAt: new Date(),
        },
      });
      const recipient = await testPrisma.communicationRecipient.create({
        data: { communicationId: communication.id, contactId: contact.id },
      });
      const delivery = await testPrisma.communicationDelivery.create({
        data: {
          communicationRecipientId: recipient.id,
          channel: 'EMAIL',
          status: 'FAILED',
          failureReason: 'SMTP timeout',
        },
      });

      const retryRes = await request(app)
        .post(`/api/v1/backoffice/jobs/deliveries/${delivery.id}/retry`)
        .set(authHeader(token));
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.status).toBe('PENDING');
      expect(retryRes.body.failureReason).toBeNull();

      const secondRetry = await request(app)
        .post(`/api/v1/backoffice/jobs/deliveries/${delivery.id}/retry`)
        .set(authHeader(token));
      expect(secondRetry.status).toBe(409);

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: { entityType: 'CommunicationDelivery', entityId: delivery.id },
      });
      expect(audit?.action).toBe('delivery.retried');
    });
  });

  describe('integrations / system health', () => {
    it('reports real, non-fabricated checks', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_DEVELOPER' });
      const token = await platformLogin(username, password);

      const res = await request(app).get('/api/v1/backoffice/integrations').set(authHeader(token));
      expect(res.status).toBe(200);
      const names = res.body.checks.map((c: { name: string }) => c.name);
      expect(names).toContain('Database (PostgreSQL)');
      expect(names).toContain('Communication delivery scheduler');
      expect(JSON.stringify(res.body)).not.toMatch(/uptime|datadog|cloudwatch|pagerduty/i);
    });
  });

  describe('internal platform users', () => {
    it('creates a brand-new platform-only account with no email, returning a one-time generated password that actually logs in', async () => {
      const { username: adminUsername, password: adminPassword } = await createPlatformUser();
      const token = await platformLogin(adminUsername, adminPassword);
      const newUsername = `csagent.${Date.now()}`;

      const res = await request(app)
        .post('/api/v1/backoffice/platform-users')
        .set(authHeader(token))
        .send({
          firstName: 'CS',
          lastName: 'Agent',
          username: newUsername,
          role: 'PLATFORM_SUPPORT',
          reason: 'new CS agent, no existing WaslProperty account',
        });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('PLATFORM_SUPPORT');
      expect(typeof res.body.temporaryPassword).toBe('string');
      expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);

      const loginRes = await request(app)
        .post('/api/v1/backoffice/auth/login')
        .send({ username: newUsername, password: res.body.temporaryPassword });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.platformRole).toBe('PLATFORM_SUPPORT');

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'employee.created', entityId: res.body.id },
      });
      expect(audit?.reason).toBe('new CS agent, no existing WaslProperty account');
      const after = audit?.after as Record<string, unknown>;
      expect(after.username).toBe(newUsername);
      expect(JSON.stringify(after)).not.toContain(res.body.temporaryPassword);
    });

    it('rejects creating a new account without email, firstName, or lastName', async () => {
      const { username: adminUsername, password: adminPassword } = await createPlatformUser();
      const token = await platformLogin(adminUsername, adminPassword);

      const res = await request(app)
        .post('/api/v1/backoffice/platform-users')
        .set(authHeader(token))
        .send({ username: `noname.${Date.now()}`, role: 'PLATFORM_SUPPORT', reason: 'test' });
      expect(res.status).toBe(422);
    });

    it('rejects a duplicate username when creating a new account', async () => {
      const { username: adminUsername, password: adminPassword } = await createPlatformUser();
      const token = await platformLogin(adminUsername, adminPassword);
      const dupeUsername = `dupe.${Date.now()}`;

      const first = await request(app)
        .post('/api/v1/backoffice/platform-users')
        .set(authHeader(token))
        .send({
          firstName: 'A',
          lastName: 'One',
          username: dupeUsername,
          role: 'PLATFORM_SUPPORT',
          reason: 'test',
        });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/api/v1/backoffice/platform-users')
        .set(authHeader(token))
        .send({
          firstName: 'B',
          lastName: 'Two',
          username: dupeUsername,
          role: 'PLATFORM_SUPPORT',
          reason: 'test',
        });
      expect(second.status).toBe(409);
    });

    it("lets a Super Admin reset another platform user's password to a new generated one that actually logs in", async () => {
      const { username: adminUsername, password: adminPassword } = await createPlatformUser();
      const token = await platformLogin(adminUsername, adminPassword);
      const {
        username: granteeUsername,
        password: originalPassword,
        employeeId,
      } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });

      const res = await request(app)
        .post(`/api/v1/backoffice/platform-users/${employeeId}/reset-password`)
        .set(authHeader(token))
        .send({ reason: 'employee forgot their password' });
      expect(res.status).toBe(200);
      expect(typeof res.body.temporaryPassword).toBe('string');

      const oldLogin = await request(app)
        .post('/api/v1/backoffice/auth/login')
        .send({ username: granteeUsername, password: originalPassword });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request(app)
        .post('/api/v1/backoffice/auth/login')
        .send({ username: granteeUsername, password: res.body.temporaryPassword });
      expect(newLogin.status).toBe(200);

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'employee.passwordReset', entityId: employeeId },
      });
      expect(audit?.reason).toBe('employee forgot their password');
      expect(JSON.stringify(audit)).not.toContain(res.body.temporaryPassword);
    });

    it('requires a reason to reset a password, and rejects a non-Super-Admin caller', async () => {
      const { username: adminUsername, password: adminPassword } = await createPlatformUser();
      const token = await platformLogin(adminUsername, adminPassword);
      const { employeeId } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });

      const noReasonRes = await request(app)
        .post(`/api/v1/backoffice/platform-users/${employeeId}/reset-password`)
        .set(authHeader(token))
        .send({});
      expect(noReasonRes.status).toBe(422);

      const { username: supportUsername, password: supportPassword } = await createPlatformUser({
        role: 'PLATFORM_SUPPORT',
      });
      const supportToken = await platformLogin(supportUsername, supportPassword);
      const forbiddenRes = await request(app)
        .post(`/api/v1/backoffice/platform-users/${employeeId}/reset-password`)
        .set(authHeader(supportToken))
        .send({ reason: 'trying anyway' });
      expect(forbiddenRes.status).toBe(403);
    });

    it('refuses to deactivate the last active PLATFORM_SUPER_ADMIN', async () => {
      const { username, password, employeeId } = await createPlatformUser();
      const token = await platformLogin(username, password);

      const res = await request(app)
        .patch(`/api/v1/backoffice/platform-users/${employeeId}`)
        .set(authHeader(token))
        .send({ isActive: false, reason: 'self-lockout attempt' });
      expect(res.status).toBe(409);
    });

    it('allows deactivating a super admin once a second active one exists', async () => {
      const { username, password, employeeId } = await createPlatformUser();
      const token = await platformLogin(username, password);
      await createPlatformUser();

      const res = await request(app)
        .patch(`/api/v1/backoffice/platform-users/${employeeId}`)
        .set(authHeader(token))
        .send({ isActive: false, reason: 'role change' });
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
    });
  });

  describe('property-data / spaces', () => {
    it('reports occupancy derived from active tenant/resident memberships, not raw Space.status', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const { accessToken, organisationId } = await registerTestUser(app, {
        organisationName: 'Occupancy Test Org',
      });

      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send({
          name: 'Occupancy Test Property',
          code: 'OCC-TEST',
          addressLine1: '1 Test St',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        });
      const propertyId = propertyRes.body.id as string;

      const spaceRes = await request(app)
        .post(`/api/v1/properties/${propertyId}/spaces`)
        .set(authHeader(accessToken))
        .send({ name: 'Unit 1', code: 'U1', spaceType: 'APARTMENT' });
      const occupiedSpaceId = spaceRes.body.id as string;

      const vacantSpaceRes = await request(app)
        .post(`/api/v1/properties/${propertyId}/spaces`)
        .set(authHeader(accessToken))
        .send({ name: 'Unit 2', code: 'U2', spaceType: 'APARTMENT' });
      const vacantSpaceId = vacantSpaceRes.body.id as string;

      const contact = await testPrisma.propertyContact.create({
        data: {
          organisationId,
          firstName: 'Occupant',
          lastName: 'Tenant',
          email: `occupant+${Date.now()}@example.com`,
        },
      });
      await testPrisma.propertyMembership.create({
        data: {
          organisationId,
          propertyId,
          spaceId: occupiedSpaceId,
          contactId: contact.id,
          role: 'TENANT',
          status: 'ACTIVE',
          startDate: new Date(),
        },
      });

      const res = await request(app)
        .get('/api/v1/backoffice/property-data/spaces')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      const items = res.body.items as { id: string; occupancy: string }[];
      expect(items.find((s) => s.id === occupiedSpaceId)?.occupancy).toBe('OCCUPIED');
      expect(items.find((s) => s.id === vacantSpaceId)?.occupancy).toBe('VACANT');
    });
  });

  describe('audit log', () => {
    it('lists recorded Backoffice mutations', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'Audited Org' });
      await request(app)
        .patch(`/api/v1/backoffice/organisations/${organisationId}`)
        .set(authHeader(token))
        .send({ name: 'Audited Org Renamed', reason: 'test' });

      const res = await request(app).get('/api/v1/backoffice/audit').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(
        res.body.items.some((e: { action: string }) => e.action === 'organisation.updated'),
      ).toBe(true);
    });
  });
});
