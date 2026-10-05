import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { BackofficeDataExplorerService } from '../../src/modules/backoffice/data-explorer/backoffice-data-explorer.service.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { buildPublicReference } from '../../src/lib/public-reference.js';
import { authHeader, createPlatformUser, registerTestUser } from '../helpers/auth.js';

const app = createApp();

async function platformLogin(username: string, password: string) {
  const res = await request(app).post('/api/v1/backoffice/auth/login').send({ username, password });
  return res.body.accessToken as string;
}

describe('backoffice data explorer', () => {
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

  describe('models list', () => {
    it('returns only the explicitly allowlisted models, never Session/EmployeeSession/PlatformAuditEvent/ContactInvite', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);

      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/models')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      const names = res.body.items.map((m: { model: string }) => m.model);
      expect(names).toContain('Organisation');
      expect(names).toContain('PropertyMembership');
      // Employee IS visible (view-only) — see the "Employee model" describe
      // block below — but never the raw session/audit tables.
      expect(names).toContain('Employee');
      for (const forbidden of [
        'Session',
        'EmployeeSession',
        'PlatformAuditEvent',
        'ContactInvite',
        'WaslSignWebhookEvent',
        'MaintenanceRequestAttachment',
      ]) {
        expect(names).not.toContain(forbidden);
      }
    });

    it('requires database.view — a role without it is rejected', async () => {
      // PLATFORM_DEVELOPER lacks platformUsers.manage but does have
      // database.view, so use an org-scoped customer token instead, which
      // has no platform capabilities at all.
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/models')
        .set(authHeader(accessToken));
      expect(res.status).toBe(401);
    });
  });

  describe('listing records', () => {
    it('rejects an unlisted/unknown model with 404, not a generic passthrough', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);

      for (const blocked of ['Session', 'EmployeeSession', 'PlatformAuditEvent', 'NotARealModel']) {
        const res = await request(app)
          .get(`/api/v1/backoffice/data-explorer/${blocked}/records`)
          .set(authHeader(token));
        expect(res.status).toBe(404);
      }
    });

    it('never returns User.passwordHash, and masks email by default', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      await registerTestUser(app, { email: `explorer-test+${Date.now()}@example.com` });

      env.BACKOFFICE_PII_MODE = 'masked';
      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/User/records')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item).not.toHaveProperty('passwordHash');
        expect(item.email).toMatch(/\*\*\*/);
      }
    });

    it('unmasks PII only with pii.view + full PII mode', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const email = `unmasked+${Date.now()}@example.com`;
      await registerTestUser(app, { email });

      env.BACKOFFICE_PII_MODE = 'full';
      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/User/records')
        .query({ search: email })
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.items[0].email).toBe(email);
    });

    it('paginates and searches server-side', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const unique = `Explorer-Org-${Date.now()}`;
      await registerTestUser(app, { organisationName: unique });

      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/Organisation/records')
        .query({ search: unique, page: 1, pageSize: 5 })
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe(unique);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(5);
    });

    it('supports a basic enum filter', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const suspended = `Suspended-Org-${Date.now()}`;
      const { organisationId } = await registerTestUser(app, { organisationName: suspended });
      await testPrisma.organisation.update({
        where: { id: organisationId },
        data: { status: 'SUSPENDED' },
      });

      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/Organisation/records')
        .query({ filters: JSON.stringify({ status: 'SUSPENDED' }), search: suspended })
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].status).toBe('SUSPENDED');
    });
  });

  describe('single record + relations', () => {
    it('resolves linked relations with friendly display labels', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader((await registerTestUser(app)).accessToken))
        .send({
          name: 'Relation Test Property',
          code: `REL-${Date.now()}`,
          addressLine1: '1 Test St',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        });
      expect(propertyRes.status).toBe(201);
      const propertyId = propertyRes.body.id as string;

      const res = await request(app)
        .get(`/api/v1/backoffice/data-explorer/Property/records/${propertyId}`)
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.record.name).toBe('Relation Test Property');
      const orgRelation = res.body.relations.find(
        (r: { field: string }) => r.field === 'organisation',
      );
      expect(orgRelation.display).toBeTruthy();
    });

    it('404s for a record id that does not exist', async () => {
      const { username, password } = await createPlatformUser();
      const token = await platformLogin(username, password);
      const res = await request(app)
        .get('/api/v1/backoffice/data-explorer/Organisation/records/does-not-exist')
        .set(authHeader(token));
      expect(res.status).toBe(404);
    });
  });

  describe('editing records', () => {
    it('requires database.edit — PLATFORM_SUPPORT (view-only) is rejected', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Edit Reject Org',
      });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ changes: { name: 'Renamed' }, reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('rejects editing a field not in the allowlist metadata', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'Bad Field Org' });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ changes: { notARealField: 'x' }, reason: 'test' });
      expect(res.status).toBe(422);
    });

    it('rejects editing a real, non-editable field (slug is view-only)', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Slug Immutable Org',
      });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ changes: { slug: 'new-slug' }, reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('rejects editing a workflow-critical ContractorQuote field like signatureStatus', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { accessToken, organisationId } = await registerTestUser(app, {
        organisationName: 'Workflow Guard Org',
      });
      const property = await testPrisma.property.create({
        data: {
          organisationId,
          publicReference: buildPublicReference('PROP'),
          name: 'WF Property',
          code: `WF-${Date.now()}`,
          addressLine1: '1 St',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        },
      });
      const contractor = await testPrisma.contractor.create({
        data: { organisationId, name: 'WF Contractor', email: `wf+${Date.now()}@example.com` },
      });
      const user = await testPrisma.user.findFirstOrThrow({
        where: { organisationMemberships: { some: { organisationId } } },
      });
      const workOrder = await testPrisma.workOrder.create({
        data: {
          organisationId,
          publicReference: buildPublicReference('WO'),
          propertyId: property.id,
          title: 'WF Work Order',
          description: 'test',
          priority: 'LOW',
          createdByUserId: user.id,
        },
      });
      const quote = await testPrisma.contractorQuote.create({
        data: {
          organisationId,
          workOrderId: workOrder.id,
          contractorId: contractor.id,
          amount: '100.00',
        },
      });
      void accessToken;

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/ContractorQuote/records/${quote.id}`)
        .set(authHeader(token))
        .send({ changes: { signatureStatus: 'SIGNED' }, reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('edits an allowed field, persists it, and records a platform audit event', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'Editable Org' });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ changes: { name: 'Renamed Via Explorer' }, reason: 'fixing a typo' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Via Explorer');

      const persisted = await testPrisma.organisation.findUniqueOrThrow({
        where: { id: organisationId },
      });
      expect(persisted.name).toBe('Renamed Via Explorer');

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: {
          action: 'dataExplorer.recordUpdated',
          entityType: 'Organisation',
          entityId: organisationId,
        },
      });
      expect(audit?.reason).toBe('fixing a typo');
      expect(audit?.before).toEqual({ name: 'Editable Org' });
      expect(audit?.after).toEqual({ name: 'Renamed Via Explorer' });
    });

    it('requires a reason', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'No Reason Org' });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ changes: { name: 'Renamed' } });
      expect(res.status).toBe(422);
    });

    it('lets PLATFORM_ADMIN (database.edit + pii.view) edit a PII-sensitive field', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, { organisationName: 'PII Edit Org' });
      const contact = await testPrisma.propertyContact.create({
        data: {
          organisationId,
          firstName: 'A',
          lastName: 'B',
          phone: '0400000000',
          email: `pii+${Date.now()}@example.com`,
        },
      });

      const res = await request(app)
        .patch(`/api/v1/backoffice/data-explorer/PropertyContact/records/${contact.id}`)
        .set(authHeader(token))
        .send({ changes: { phone: '0499999999' }, reason: 'test' });
      expect(res.status).toBe(200);
    });

    it('rejects editing a PII-sensitive field when the actor lacks pii.view, even if database.edit is present — a service-level guard independent of any real role today', async () => {
      const { organisationId } = await registerTestUser(app, { organisationName: 'PII Guard Org' });
      const contact = await testPrisma.propertyContact.create({
        data: {
          organisationId,
          firstName: 'A',
          lastName: 'B',
          phone: '0400000000',
          email: `pii+${Date.now()}@example.com`,
        },
      });

      const service = new BackofficeDataExplorerService(testPrisma);
      await expect(
        service.updateRecord(
          'PropertyContact',
          contact.id,
          { changes: { phone: '0499999999' }, reason: 'test' },
          { employeeId: 'irrelevant', platformRole: 'PLATFORM_SUPER_ADMIN' },
          ['database.edit'], // deliberately no pii.view
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('deleting records', () => {
    it('requires PLATFORM_SUPER_ADMIN — PLATFORM_ADMIN (has database.edit) is rejected', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Delete Reject Org',
      });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ reason: 'test' });
      expect(res.status).toBe(403);
    });

    it('requires a reason', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Delete No Reason Org',
      });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({});
      expect(res.status).toBe(422);
    });

    it('allows deleting a row from a field-view-only/log-shaped model too — deletion is universal, only field-editing is restricted', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Delete Log Org',
      });
      const event = await testPrisma.activityEvent.create({
        data: { organisationId, eventType: 'PROPERTY_CREATED', title: 'test event' },
      });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/ActivityEvent/records/${event.id}`)
        .set(authHeader(token))
        .send({ reason: 'test' });
      expect(res.status).toBe(204);
      expect(await testPrisma.activityEvent.findUnique({ where: { id: event.id } })).toBeNull();
    });

    it('deletes an allowed record as PLATFORM_SUPER_ADMIN, persists it, and audits it with a before snapshot', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      // A bare Organisation with no memberships/properties — registerTestUser
      // creates dependent rows that would trip the FK-conflict case tested
      // separately below.
      const { id: organisationId } = await testPrisma.organisation.create({
        data: { name: 'Delete Target Org', slug: `delete-target-${Date.now()}` },
      });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ reason: 'cleaning up test data' });
      expect(res.status).toBe(204);

      const gone = await testPrisma.organisation.findUnique({ where: { id: organisationId } });
      expect(gone).toBeNull();

      const audit = await testPrisma.platformAuditEvent.findFirst({
        where: {
          action: 'dataExplorer.recordDeleted',
          entityType: 'Organisation',
          entityId: organisationId,
        },
      });
      expect(audit?.reason).toBe('cleaning up test data');
      expect((audit?.before as Record<string, unknown> | null)?.name).toBe('Delete Target Org');
    });

    it('404s deleting a record that does not exist', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);

      const res = await request(app)
        .delete('/api/v1/backoffice/data-explorer/Organisation/records/does-not-exist')
        .set(authHeader(token))
        .send({ reason: 'test' });
      expect(res.status).toBe(404);
    });

    it('returns a clear conflict, not a 500, when other records still reference the row', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { organisationId } = await registerTestUser(app, {
        organisationName: 'Delete FK Guard Org',
      });
      // The organisation now has a Property (created via registerTestUser's
      // implicit staff org) — actually create one explicitly to be sure.
      await testPrisma.property.create({
        data: {
          organisationId,
          publicReference: buildPublicReference('PROP'),
          name: 'Blocking Property',
          code: `BLOCK-${Date.now()}`,
          addressLine1: '1 St',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        },
      });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/Organisation/records/${organisationId}`)
        .set(authHeader(token))
        .send({ reason: 'test' });
      expect(res.status).toBe(409);
    });

    it('allows deleting an Employee row too (Super Admin real power, matching the SQL Console trust model)', async () => {
      const { username, password } = await createPlatformUser({ role: 'PLATFORM_SUPER_ADMIN' });
      const token = await platformLogin(username, password);
      const { employeeId: targetId } = await createPlatformUser({ role: 'PLATFORM_SUPPORT' });

      const res = await request(app)
        .delete(`/api/v1/backoffice/data-explorer/Employee/records/${targetId}`)
        .set(authHeader(token))
        .send({ reason: 'test cleanup' });
      expect(res.status).toBe(204);

      const gone = await testPrisma.employee.findUnique({ where: { id: targetId } });
      expect(gone).toBeNull();
    });
  });
});
