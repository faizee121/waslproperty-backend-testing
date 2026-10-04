import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser, residentAccessToken } from '../helpers/auth.js';

const app = createApp();

async function createProperty(accessToken: string, code: string, name = code) {
  const res = await request(app).post('/api/v1/properties').set(authHeader(accessToken)).send({
    name,
    code,
    addressLine1: '1 Test Street',
    city: 'Sydney',
    country: 'Australia',
    propertyType: 'RESIDENTIAL',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addPerson(
  accessToken: string,
  propertyId: string,
  role: string,
  overrides: Partial<{ email: string; firstName: string; lastName: string }> = {},
) {
  const email =
    overrides.email ?? `person+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await request(app)
    .post(`/api/v1/properties/${propertyId}/memberships`)
    .set(authHeader(accessToken))
    .send({
      email,
      firstName: overrides.firstName ?? 'Test',
      lastName: overrides.lastName ?? 'Person',
      role,
    });
  expect(res.status).toBe(201);
  return {
    membershipId: res.body.id as string,
    contactId: res.body.contactId as string,
    userId: res.body.contact.userId as string,
  };
}

async function assignExisting(
  accessToken: string,
  propertyId: string,
  contactId: string,
  role: string,
) {
  const res = await request(app)
    .post(`/api/v1/properties/${propertyId}/memberships/assign`)
    .set(authHeader(accessToken))
    .send({ contactId, role });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('property-scoped role authorization', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('portfolio scoping — PROPERTY_MANAGER across multiple properties', () => {
    it('a manager assigned to A and B sees exactly A and B in the property list, never C, and gets 404 — not 403 — reaching C directly by id', async () => {
      const owner = await registerTestUser(app);
      const propertyA = await createProperty(owner.accessToken, 'PORT-A');
      const propertyB = await createProperty(owner.accessToken, 'PORT-B');
      const propertyC = await createProperty(owner.accessToken, 'PORT-C');

      const person = await addPerson(owner.accessToken, propertyA, 'PROPERTY_MANAGER');
      await assignExisting(owner.accessToken, propertyB, person.contactId, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const listRes = await request(app).get('/api/v1/properties').set(authHeader(managerToken));
      expect(listRes.status).toBe(200);
      const ids = listRes.body.items.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([propertyA, propertyB]));
      expect(ids).not.toContain(propertyC);
      expect(listRes.body.total).toBe(2);

      const okA = await request(app)
        .get(`/api/v1/properties/${propertyA}`)
        .set(authHeader(managerToken));
      expect(okA.status).toBe(200);
      const okB = await request(app)
        .get(`/api/v1/properties/${propertyB}`)
        .set(authHeader(managerToken));
      expect(okB.status).toBe(200);

      // Never leaks whether C exists — 404, matching org-crossing behaviour.
      const deniedC = await request(app)
        .get(`/api/v1/properties/${propertyC}`)
        .set(authHeader(managerToken));
      expect(deniedC.status).toBe(404);
    });

    it('a manager on A cannot manage a space that belongs to B, even within the same organisation', async () => {
      const owner = await registerTestUser(app);
      const propertyA = await createProperty(owner.accessToken, 'SPACE-A');
      const propertyB = await createProperty(owner.accessToken, 'SPACE-B');

      const person = await addPerson(owner.accessToken, propertyA, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const spaceBRes = await request(app)
        .post(`/api/v1/properties/${propertyB}/spaces`)
        .set(authHeader(owner.accessToken))
        .send({ name: 'Unit 1', code: 'B-101', spaceType: 'APARTMENT' });
      expect(spaceBRes.status).toBe(201);
      const spaceBId = spaceBRes.body.id as string;

      // Same-organisation, different (unassigned) property — a real
      // resource the caller's org can see, just not one they're scoped
      // to: 403, not 404 (404 is reserved for resources invisible to the
      // caller's organisation entirely — see multi-org-access.test.ts).
      const getRes = await request(app)
        .get(`/api/v1/spaces/${spaceBId}`)
        .set(authHeader(managerToken));
      expect(getRes.status).toBe(403);

      const patchRes = await request(app)
        .patch(`/api/v1/spaces/${spaceBId}`)
        .set(authHeader(managerToken))
        .send({ name: 'Renamed' });
      expect(patchRes.status).toBe(403);

      // Sanity: the same manager CAN manage their own property's space.
      const spaceARes = await request(app)
        .post(`/api/v1/properties/${propertyA}/spaces`)
        .set(authHeader(managerToken))
        .send({ name: 'Unit 1', code: 'A-101', spaceType: 'APARTMENT' });
      expect(spaceARes.status).toBe(201);
    });
  });

  describe('FACILITY_MANAGER default capabilities', () => {
    it('can view and act on maintenance/work orders but cannot manage people or contractors by default', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'FM-01');
      const person = await addPerson(owner.accessToken, propertyId, 'FACILITY_MANAGER');
      const fmToken = residentAccessToken(person.userId, owner.organisationId, person.contactId);

      const meRes = await request(app).get('/api/v1/organisations/me').set(authHeader(fmToken));
      expect(meRes.status).toBe(200);
      expect(meRes.body.capabilities).toEqual(
        expect.arrayContaining([
          'maintenance.view',
          'maintenance.manage',
          'work_orders.view',
          'work_orders.manage',
        ]),
      );
      expect(meRes.body.capabilities).not.toContain('people.manage');
      expect(meRes.body.capabilities).not.toContain('contractors.manage');
      expect(meRes.body.capabilities).not.toContain('quotes.approve');

      const addPersonRes = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(fmToken))
        .send({ email: 'nope@example.com', firstName: 'No', lastName: 'Pe', role: 'TENANT' });
      expect(addPersonRes.status).toBe(403);
    });
  });

  describe('TENANT / RESIDENT never gain operational access', () => {
    it('a TENANT has zero effective operational capabilities and cannot manage the property', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'TEN-01');
      const person = await addPerson(owner.accessToken, propertyId, 'TENANT');
      const tenantToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const meRes = await request(app).get('/api/v1/organisations/me').set(authHeader(tenantToken));
      expect(meRes.status).toBe(200);
      expect(meRes.body.capabilities).toEqual([]);

      // Read-only self view of their own property still works (pre-existing behaviour).
      const getRes = await request(app)
        .get(`/api/v1/properties/${propertyId}`)
        .set(authHeader(tenantToken));
      expect(getRes.status).toBe(200);

      const patchRes = await request(app)
        .patch(`/api/v1/properties/${propertyId}`)
        .set(authHeader(tenantToken))
        .send({ name: 'Hijacked' });
      expect(patchRes.status).toBe(403);
    });
  });

  describe('mixed persona — same contact, different roles on different properties', () => {
    it('TENANT on A + PROPERTY_MANAGER on B yields correctly different effective capabilities per property', async () => {
      const owner = await registerTestUser(app);
      const propertyA = await createProperty(owner.accessToken, 'MIX-A');
      const propertyB = await createProperty(owner.accessToken, 'MIX-B');

      const person = await addPerson(owner.accessToken, propertyA, 'TENANT');
      await assignExisting(owner.accessToken, propertyB, person.contactId, 'PROPERTY_MANAGER');
      const token = residentAccessToken(person.userId, owner.organisationId, person.contactId);

      // Cannot manage spaces on A (only TENANT there — TENANT grants no
      // operational capability at all).
      const spaceA = await request(app)
        .post(`/api/v1/properties/${propertyA}/spaces`)
        .set(authHeader(token))
        .send({ name: 'Unit 1', code: 'A-101', spaceType: 'APARTMENT' });
      expect(spaceA.status).toBe(403);

      // Can manage spaces on B (PROPERTY_MANAGER there).
      const spaceB = await request(app)
        .post(`/api/v1/properties/${propertyB}/spaces`)
        .set(authHeader(token))
        .send({ name: 'Unit 1', code: 'B-101', spaceType: 'APARTMENT' });
      expect(spaceB.status).toBe(201);

      const listRes = await request(app).get('/api/v1/properties').set(authHeader(token));
      const ids = listRes.body.items.map((p: { id: string }) => p.id);
      expect(ids).toContain(propertyB);
      expect(ids).not.toContain(propertyA); // TENANT grants no property.view capability
    });
  });

  describe('inactive membership grants nothing', () => {
    it('ending a PROPERTY_MANAGER membership immediately removes their access', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'END-01');
      const person = await addPerson(owner.accessToken, propertyId, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const beforeRes = await request(app)
        .post(`/api/v1/properties/${propertyId}/spaces`)
        .set(authHeader(managerToken))
        .send({ name: 'Unit 1', code: 'END-101', spaceType: 'APARTMENT' });
      expect(beforeRes.status).toBe(201);

      const endRes = await request(app)
        .post(`/api/v1/people/memberships/${person.membershipId}/end`)
        .set(authHeader(owner.accessToken));
      expect(endRes.status).toBe(200);

      const afterRes = await request(app)
        .post(`/api/v1/properties/${propertyId}/spaces`)
        .set(authHeader(managerToken))
        .send({ name: 'Unit 2', code: 'END-102', spaceType: 'APARTMENT' });
      expect(afterRes.status).toBe(403);
    });
  });

  describe('organisation role overrides', () => {
    it('disabling contractors.view for PROPERTY_MANAGER removes it from effective capabilities; reset restores the default', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'OVR-01');
      const person = await addPerson(owner.accessToken, propertyId, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const before = await request(app)
        .get('/api/v1/organisations/me')
        .set(authHeader(managerToken));
      expect(before.body.capabilities).toContain('contractors.view');

      const disableRes = await request(app)
        .put('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER')
        .set(authHeader(owner.accessToken))
        .send({ overrides: [{ capability: 'contractors.view', granted: false }] });
      expect(disableRes.status).toBe(200);
      const disabledRow = disableRes.body.capabilities.find(
        (c: { capability: string }) => c.capability === 'contractors.view',
      );
      expect(disabledRow.granted).toBe(false);
      expect(disabledRow.isOverride).toBe(true);

      const after = await request(app)
        .get('/api/v1/organisations/me')
        .set(authHeader(managerToken));
      expect(after.body.capabilities).not.toContain('contractors.view');

      const contractorsListRes = await request(app)
        .get('/api/v1/contractors')
        .set(authHeader(managerToken));
      expect(contractorsListRes.status).toBe(403);

      const resetRes = await request(app)
        .post('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER/reset')
        .set(authHeader(owner.accessToken));
      expect(resetRes.status).toBe(200);

      const afterReset = await request(app)
        .get('/api/v1/organisations/me')
        .set(authHeader(managerToken));
      expect(afterReset.body.capabilities).toContain('contractors.view');
    });

    it('a PROPERTY_MANAGER cannot create a new property by default, but can once the organisation grants property.manage', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'CREATE-01');
      const person = await addPerson(owner.accessToken, propertyId, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const beforeRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(managerToken))
        .send({
          name: 'New Block',
          code: 'CREATE-02',
          addressLine1: '2 Test Street',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        });
      expect(beforeRes.status).toBe(403);

      const grantRes = await request(app)
        .put('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER')
        .set(authHeader(owner.accessToken))
        .send({ overrides: [{ capability: 'property.manage', granted: true }] });
      expect(grantRes.status).toBe(200);

      const afterRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(managerToken))
        .send({
          name: 'New Block',
          code: 'CREATE-02',
          addressLine1: '2 Test Street',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        });
      expect(afterRes.status).toBe(201);
      expect(afterRes.body.code).toBe('CREATE-02');
    });

    it('a PROPERTY_MANAGER with property.manage granted but no existing property membership still cannot create one', async () => {
      // property.manage is only ever resolved from an existing, ACTIVE
      // PropertyMembership — a role override alone grants nothing to a
      // contact who holds no membership at all to hang it on.
      const owner = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER')
        .set(authHeader(owner.accessToken))
        .send({ overrides: [{ capability: 'property.manage', granted: true }] });

      const unaffiliatedToken = residentAccessToken(
        'user_ghost',
        owner.organisationId,
        'contact_ghost',
      );
      const res = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(unaffiliatedToken))
        .send({
          name: 'New Block',
          code: 'CREATE-03',
          addressLine1: '3 Test Street',
          city: 'Sydney',
          country: 'Australia',
          propertyType: 'RESIDENTIAL',
        });
      expect(res.status).toBe(403);
    });

    it('rejects a PROPERTY_MANAGER (or MEMBER) from changing role configuration — organisation admins only', async () => {
      const owner = await registerTestUser(app);
      const propertyId = await createProperty(owner.accessToken, 'RBAC-01');
      const person = await addPerson(owner.accessToken, propertyId, 'PROPERTY_MANAGER');
      const managerToken = residentAccessToken(
        person.userId,
        owner.organisationId,
        person.contactId,
      );

      const res = await request(app)
        .put('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER')
        .set(authHeader(managerToken))
        .send({ overrides: [{ capability: 'contractors.view', granted: false }] });
      expect(res.status).toBe(403);

      const getRes = await request(app)
        .get('/api/v1/organisations/me/role-permissions')
        .set(authHeader(managerToken));
      expect(getRes.status).toBe(403);
    });

    it('rejects configuring TENANT/RESIDENT — they have no configurable permissions', async () => {
      const owner = await registerTestUser(app);
      const res = await request(app)
        .put('/api/v1/organisations/me/role-permissions/TENANT')
        .set(authHeader(owner.accessToken))
        .send({ overrides: [{ capability: 'maintenance.view', granted: true }] });
      expect(res.status).toBe(422);
    });

    it('OWNER/ADMIN can fetch the full role permissions summary grouped for the editor UI', async () => {
      const owner = await registerTestUser(app);
      const res = await request(app)
        .get('/api/v1/organisations/me/role-permissions')
        .set(authHeader(owner.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.configurableRoles).toEqual(
        expect.arrayContaining([
          'PROPERTY_MANAGER',
          'FACILITY_MANAGER',
          'AGENT',
          'COMMITTEE_MEMBER',
          'OWNER',
        ]),
      );
      expect(res.body.configurableRoles).not.toContain('TENANT');
      expect(res.body.configurableRoles).not.toContain('RESIDENT');
      expect(Array.isArray(res.body.capabilityGroups)).toBe(true);
      const pmRole = res.body.roles.find((r: { role: string }) => r.role === 'PROPERTY_MANAGER');
      expect(
        pmRole.capabilities.find((c: { capability: string }) => c.capability === 'property.view')
          .granted,
      ).toBe(true);
    });
  });

  describe('org staff (OWNER/ADMIN) access is unaffected by the new model', () => {
    it('OWNER sees every property in the organisation regardless of any PropertyMembership', async () => {
      const owner = await registerTestUser(app);
      await createProperty(owner.accessToken, 'STAFF-A');
      await createProperty(owner.accessToken, 'STAFF-B');

      const res = await request(app).get('/api/v1/properties').set(authHeader(owner.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);

      const meRes = await request(app)
        .get('/api/v1/organisations/me')
        .set(authHeader(owner.accessToken));
      expect(meRes.body.capabilities.length).toBeGreaterThan(15);
    });
  });
});
