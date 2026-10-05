import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlainUser, registerTestUser } from '../helpers/auth.js';

const app = createApp();

const validProperty = {
  name: 'Marina Heights',
  code: 'MARINA-HT',
  addressLine1: '1 Marina Blvd',
  city: 'Dubai',
  country: 'UAE',
  propertyType: 'MIXED_USE',
};

const validSpace = {
  name: 'Apartment 1204',
  code: '1204',
  spaceType: 'APARTMENT',
  floor: '12',
  sizeSqft: 950,
};

/** Registers a new org and, via PATCH /organisations/me, sets its
 * jurisdiction to AU so STRATA_MANAGEMENT is enabled. */
async function registerAuOrg(overrides: Parameters<typeof registerTestUser>[1] = {}) {
  const session = await registerTestUser(app, overrides);
  const patchRes = await request(app)
    .patch('/api/v1/organisations/me')
    .set(authHeader(session.accessToken))
    .send({ countryCode: 'AU' });
  expect(patchRes.status).toBe(200);
  return session;
}

async function createProperty(accessToken: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send({ ...validProperty, ...overrides });
}

async function createSpace(
  accessToken: string,
  propertyId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/spaces`)
    .set(authHeader(accessToken))
    .send({ ...validSpace, ...overrides });
}

describe('M11-A strata foundation', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('organisation jurisdiction / feature resolution', () => {
    it('a new organisation has no countryCode and no features by default', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app).get('/api/v1/organisations/me').set(authHeader(accessToken));
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBeNull();
      expect(res.body.features).toEqual([]);
    });

    it('setting countryCode=AU resolves STRATA_MANAGEMENT in the feature set', async () => {
      const { accessToken } = await registerAuOrg();
      const res = await request(app).get('/api/v1/organisations/me').set(authHeader(accessToken));
      expect(res.body.countryCode).toBe('AU');
      expect(res.body.features).toContain('STRATA_MANAGEMENT');
    });

    it('a non-AU country code does not enable STRATA_MANAGEMENT', async () => {
      const { accessToken } = await registerTestUser(app);
      const patchRes = await request(app)
        .patch('/api/v1/organisations/me')
        .set(authHeader(accessToken))
        .send({ countryCode: 'US' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.features).toEqual([]);
    });

    it('rejects an unsupported country code', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .patch('/api/v1/organisations/me')
        .set(authHeader(accessToken))
        .send({ countryCode: 'ZZ' });
      expect(res.status).toBe(422);
    });

    it('changing currencyCode never changes countryCode/features, and vice versa', async () => {
      const { accessToken } = await registerAuOrg();
      const currencyRes = await request(app)
        .patch('/api/v1/organisations/me')
        .set(authHeader(accessToken))
        .send({ currencyCode: 'EUR' });
      expect(currencyRes.status).toBe(200);
      expect(currencyRes.body.countryCode).toBe('AU');

      const me = await request(app).get('/api/v1/organisations/me').set(authHeader(accessToken));
      expect(me.body.currencyCode).toBe('EUR');
      expect(me.body.features).toContain('STRATA_MANAGEMENT');
    });
  });

  describe('an ordinary (non-strata) property is completely unaffected', () => {
    it('creates and reads back a normal property with strata fields absent/false', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await createProperty(accessToken);
      expect(res.status).toBe(201);
      expect(res.body.isStrataManaged).toBe(false);
      expect(res.body.strataPlanNumber).toBeNull();
      expect(res.body.strataSchemeName).toBeNull();

      const getRes = await request(app)
        .get(`/api/v1/properties/${res.body.id}`)
        .set(authHeader(accessToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.isStrataManaged).toBe(false);
    });

    it('an ordinary non-AU-org property update with no strata fields still succeeds', async () => {
      const { accessToken } = await registerTestUser(app);
      const created = await createProperty(accessToken);
      const res = await request(app)
        .patch(`/api/v1/properties/${created.body.id}`)
        .set(authHeader(accessToken))
        .send({ name: 'Renamed Building' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Building');
    });

    it('a normal space is unaffected: isStrataLot false, lotNumber/entitlement null', async () => {
      const { accessToken } = await registerTestUser(app);
      const property = await createProperty(accessToken);
      const res = await createSpace(accessToken, property.body.id);
      expect(res.status).toBe(201);
      expect(res.body.isStrataLot).toBe(false);
      expect(res.body.lotNumber).toBeNull();
      expect(res.body.entitlementValue).toBeNull();
    });
  });

  describe('backend enforcement — STRATA_MANAGEMENT required to set strata fields', () => {
    it('rejects setting isStrataManaged on a property when the org lacks STRATA_MANAGEMENT', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await createProperty(accessToken, { isStrataManaged: true });
      expect(res.status).toBe(403);
    });

    it('rejects setting strataPlanNumber via PATCH when the org lacks STRATA_MANAGEMENT', async () => {
      const { accessToken } = await registerTestUser(app);
      const created = await createProperty(accessToken);
      const res = await request(app)
        .patch(`/api/v1/properties/${created.body.id}`)
        .set(authHeader(accessToken))
        .send({ strataPlanNumber: 'SP12345' });
      expect(res.status).toBe(403);
    });

    it('rejects setting isStrataLot on a space when the org lacks STRATA_MANAGEMENT', async () => {
      const { accessToken } = await registerTestUser(app);
      const property = await createProperty(accessToken);
      const res = await createSpace(accessToken, property.body.id, { isStrataLot: true });
      expect(res.status).toBe(403);
    });

    it('a UI bypass attempt (direct API call) is rejected the same way the UI would prevent it', async () => {
      // Simulates a client racing past a hidden/disabled control — the
      // backend must reject regardless of what the frontend shows.
      const { accessToken } = await registerTestUser(app);
      const res = await createProperty(accessToken, {
        isStrataManaged: true,
        strataPlanNumber: 'SP99999',
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('configuring a property as strata (AU organisation)', () => {
    it('creates a property with strata metadata and it persists', async () => {
      const { accessToken } = await registerAuOrg();
      const res = await createProperty(accessToken, {
        isStrataManaged: true,
        strataPlanNumber: 'SP12345',
        strataSchemeName: 'Owners Corporation SP12345',
      });
      expect(res.status).toBe(201);
      expect(res.body.isStrataManaged).toBe(true);
      expect(res.body.strataPlanNumber).toBe('SP12345');
      expect(res.body.strataSchemeName).toBe('Owners Corporation SP12345');

      const getRes = await request(app)
        .get(`/api/v1/properties/${res.body.id}`)
        .set(authHeader(accessToken));
      expect(getRes.body.isStrataManaged).toBe(true);
      expect(getRes.body.strataPlanNumber).toBe('SP12345');
    });

    it('configures an existing ordinary property as strata via PATCH', async () => {
      const { accessToken } = await registerAuOrg();
      const created = await createProperty(accessToken);
      expect(created.body.isStrataManaged).toBe(false);

      const res = await request(app)
        .patch(`/api/v1/properties/${created.body.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: true, strataPlanNumber: 'SP54321' });
      expect(res.status).toBe(200);
      expect(res.body.isStrataManaged).toBe(true);
      expect(res.body.strataPlanNumber).toBe('SP54321');
    });
  });

  describe('lot/unit foundation — reuses Space, with entitlement stored but inert', () => {
    it('creates a strata lot with a lot number and entitlement value', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken, { isStrataManaged: true });
      const res = await createSpace(accessToken, property.body.id, {
        isStrataLot: true,
        lotNumber: '43',
        entitlementValue: 125,
      });
      expect(res.status).toBe(201);
      expect(res.body.isStrataLot).toBe(true);
      expect(res.body.lotNumber).toBe('43');
      expect(res.body.entitlementValue).toBe('125');

      const getRes = await request(app)
        .get(`/api/v1/spaces/${res.body.id}`)
        .set(authHeader(accessToken));
      expect(getRes.body.lotNumber).toBe('43');
      expect(getRes.body.entitlementValue).toBe('125');
    });

    it('rejects marking a space a strata lot when its property is not strata-managed', async () => {
      const { accessToken } = await registerAuOrg();
      // Property created WITHOUT isStrataManaged, even though the org can.
      const property = await createProperty(accessToken);
      const res = await createSpace(accessToken, property.body.id, { isStrataLot: true });
      expect(res.status).toBe(409);
    });

    it('spaces/lots remain scoped to their organisation and property regardless of strata status', async () => {
      const orgA = await registerAuOrg({ email: `a+${Date.now()}@example.com` });
      const orgB = await registerAuOrg({ email: `b+${Date.now()}@example.com` });

      const propertyA = await createProperty(orgA.accessToken, { isStrataManaged: true });
      await createSpace(orgA.accessToken, propertyA.body.id, { isStrataLot: true, lotNumber: '1' });

      // Org B cannot see org A's strata property at all — same isolation
      // rule as every other property/space, untouched by M11-A.
      const crossOrgRes = await request(app)
        .get(`/api/v1/properties/${propertyA.body.id}`)
        .set(authHeader(orgB.accessToken));
      expect(crossOrgRes.status).toBe(404);
    });
  });

  describe('ownership — reuses existing PropertyContact/PropertyMembership, no parallel model', () => {
    it('an owner assigned to a strata lot is visible via the existing membership/people model', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken, { isStrataManaged: true });
      const space = await createSpace(accessToken, property.body.id, {
        isStrataLot: true,
        lotNumber: '7',
      });

      const contactRes = await request(app)
        .post(`/api/v1/properties/${property.body.id}/memberships`)
        .set(authHeader(accessToken))
        .send({
          firstName: 'Olivia',
          lastName: 'Owner',
          email: `olivia+${Date.now()}@example.com`,
          role: 'OWNER',
          spaceId: space.body.id,
        });
      expect(contactRes.status).toBe(201);

      const spaceDetail = await request(app)
        .get(`/api/v1/spaces/${space.body.id}`)
        .set(authHeader(accessToken));
      expect(spaceDetail.body.owners).toHaveLength(1);
      expect(spaceDetail.body.owners[0].firstName).toBe('Olivia');
      expect(spaceDetail.body.lotNumber).toBe('7');
    });
  });

  describe('permissions remain enforced', () => {
    it('a MEMBER cannot configure a property as strata (OWNER/ADMIN only, same as any property update)', async () => {
      const { accessToken, organisationId } = await registerAuOrg();
      const property = await createProperty(accessToken);

      const memberEmail = `member+${Date.now()}@example.com`;
      const { userId: memberUserId } = await createPlainUser({ email: memberEmail });
      await testPrisma.organisationMembership.create({
        data: { organisationId, userId: memberUserId, role: 'MEMBER' },
      });
      const memberLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: memberEmail, password: 'resident-secret-1' });

      const res = await request(app)
        .patch(`/api/v1/properties/${property.body.id}`)
        .set(authHeader(memberLogin.body.accessToken))
        .send({ isStrataManaged: true });
      expect(res.status).toBe(403);
    });

    it('a MEMBER can still only change org jurisdiction via OWNER/ADMIN, matching currency', async () => {
      const { organisationId } = await registerTestUser(app);
      const memberEmail = `member2+${Date.now()}@example.com`;
      const { userId: memberUserId } = await createPlainUser({ email: memberEmail });
      await testPrisma.organisationMembership.create({
        data: { organisationId, userId: memberUserId, role: 'MEMBER' },
      });
      const memberLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: memberEmail, password: 'resident-secret-1' });

      const res = await request(app)
        .patch('/api/v1/organisations/me')
        .set(authHeader(memberLogin.body.accessToken))
        .send({ countryCode: 'AU' });
      expect(res.status).toBe(403);
    });
  });
});
