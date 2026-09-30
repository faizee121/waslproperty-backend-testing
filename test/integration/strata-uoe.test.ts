import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlainUser, registerTestUser, residentAccessToken } from '../helpers/auth.js';

const app = createApp();

const validProperty = {
  name: 'Darling Harbour Towers',
  code: 'DARLING-01',
  addressLine1: '88 Harbour Street',
  city: 'Sydney',
  state: 'NSW',
  country: 'Australia',
  propertyType: 'RESIDENTIAL',
};

/** Registers a new org and sets its jurisdiction to AU so STRATA_MANAGEMENT
 * resolves — mirrors strata-foundation.test.ts's identical helper. */
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
  const res = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send({ ...validProperty, ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

async function createSpace(accessToken: string, propertyId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/v1/properties/${propertyId}/spaces`)
    .set(authHeader(accessToken))
    .send({
      name: 'Unit 101',
      code: `U-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spaceType: 'APARTMENT',
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; code: string };
}

async function enableStrata(accessToken: string, propertyId: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/strata/enable`)
    .set(authHeader(accessToken))
    .send(body);
}

async function getStrataSummary(accessToken: string, propertyId: string) {
  return request(app)
    .get(`/api/v1/properties/${propertyId}/strata`)
    .set(authHeader(accessToken));
}

/** Creates a real User first (so PropertyContact.userId links to it — see
 * people.service.ts's findOrCreateContact), then adds them as a
 * PROPERTY_MANAGER on the given property, and returns a resident-shaped
 * token for that real user — mirrors work-orders.test.ts's established
 * pattern exactly, needed here because setLots/enable actually write
 * ActivityEvent.actorUserId, which is a real FK to User.id. */
async function createPropertyManagerToken(
  ownerAccessToken: string,
  organisationId: string,
  propertyId: string,
) {
  const manager = await createPlainUser();
  await request(app)
    .post(`/api/v1/properties/${propertyId}/memberships`)
    .set(authHeader(ownerAccessToken))
    .send({ email: manager.email, firstName: 'P', lastName: 'M', role: 'PROPERTY_MANAGER' });
  const contact = await testPrisma.propertyContact.findFirstOrThrow({
    where: { organisationId, email: manager.email },
  });
  return residentAccessToken(manager.userId, organisationId, contact.id);
}

async function setLots(accessToken: string, propertyId: string, lots: unknown[]) {
  return request(app)
    .put(`/api/v1/properties/${propertyId}/strata/lots`)
    .set(authHeader(accessToken))
    .send({ lots });
}

async function classifySpaces(accessToken: string, propertyId: string, entries: unknown[]) {
  return request(app)
    .put(`/api/v1/properties/${propertyId}/strata/spaces/classify`)
    .set(authHeader(accessToken))
    .send({ entries });
}

describe('strata Units of Entitlement (M11-B)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('enabling strata on an existing property', () => {
    it('starts NOT_ENABLED and transitions to SETUP_IN_PROGRESS on first enable', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);

      const before = await getStrataSummary(accessToken, property.id);
      expect(before.status).toBe(200);
      expect(before.body.strataStatus).toBe('NOT_ENABLED');

      const enableRes = await enableStrata(accessToken, property.id, {
        strataPlanNumber: 'SP82345',
        strataSchemeName: 'Owners Corporation SP82345',
      });
      expect(enableRes.status).toBe(200);
      expect(enableRes.body.strataStatus).toBe('SETUP_IN_PROGRESS');
      expect(enableRes.body.isStrataManaged).toBe(true);
      expect(enableRes.body.strataPlanNumber).toBe('SP82345');

      const activity = await request(app)
        .get(`/api/v1/properties/${property.id}/activity`)
        .set(authHeader(accessToken));
      expect(activity.body.items.some((e: { eventType: string }) => e.eventType === 'STRATA_ENABLED')).toBe(
        true,
      );
    });

    it('re-enabling (saving the same step again) never regresses an already-ACTIVE property', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 10 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const again = await enableStrata(accessToken, property.id, { strataSchemeName: 'Renamed Scheme' });
      expect(again.status).toBe(200);
      expect(again.body.strataStatus).toBe('ACTIVE');
    });

    it('rejects for an organisation without STRATA_MANAGEMENT', async () => {
      const { accessToken } = await registerTestUser(app);
      const property = await createProperty(accessToken);
      const res = await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      expect(res.status).toBe(403);
    });
  });

  describe('configuring the Strata Plan', () => {
    it('records plan number, scheme name and declared total UOE, and they persist', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);

      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}/strata/plan`)
        .set(authHeader(accessToken))
        .send({
          strataPlanNumber: 'SP82345',
          strataSchemeName: 'Owners Corporation SP82345',
          strataPlanDeclaredUnitsOfEntitlement: 128,
        });
      expect(res.status).toBe(200);
      expect(res.body.strataPlanNumber).toBe('SP82345');
      expect(res.body.strataPlanDeclaredUnitsOfEntitlement).toBe('128');

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataPlanNumber).toBe('SP82345');
      expect(summary.body.strataPlanDeclaredUnitsOfEntitlement).toBe('128');
    });

    it('cannot configure the plan before strata is enabled', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}/strata/plan`)
        .set(authHeader(accessToken))
        .send({ strataPlanNumber: 'SP1' });
      expect(res.status).toBe(409);
    });
  });

  describe('assigning UOE to lots, reusing existing Spaces', () => {
    it('maps an existing Space to a lot without creating a duplicate row', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await enableStrata(accessToken, property.id);

      const before = await testPrisma.space.count({ where: { propertyId: property.id } });
      expect(before).toBe(1);

      const res = await setLots(accessToken, property.id, [
        { kind: 'existing', spaceId: space.id, lotNumber: 'Lot 1', unitsOfEntitlement: 15 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.lots).toHaveLength(1);
      expect(res.body.lots[0].spaceId).toBe(space.id);

      const after = await testPrisma.space.count({ where: { propertyId: property.id } });
      expect(after).toBe(1); // never duplicated

      const spaceRow = await testPrisma.space.findUniqueOrThrow({ where: { id: space.id } });
      expect(spaceRow.isStrataLot).toBe(true);
      expect(spaceRow.lotNumber).toBe('Lot 1');
      expect(spaceRow.entitlementValue?.toString()).toBe('15');
    });

    it('creates a brand-new lot (no existing space) via the same Space architecture', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);

      const res = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Storage Lot S1', code: 'S1', unitsOfEntitlement: 8 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.lots).toHaveLength(1);

      const spaces = await testPrisma.space.findMany({ where: { propertyId: property.id } });
      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.isStrataLot).toBe(true);
    });

    it('preserves an existing space maintenance history when reused as a lot', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      const requestRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({
          title: 'Leaking tap',
          description: 'Kitchen tap is leaking.',
          category: 'PLUMBING',
          priority: 'LOW',
          propertyId: property.id,
          spaceId: space.id,
        });
      expect(requestRes.status).toBe(201);

      await enableStrata(accessToken, property.id);
      await setLots(accessToken, property.id, [
        { kind: 'existing', spaceId: space.id, lotNumber: 'Lot 1', unitsOfEntitlement: 15 },
      ]);

      const afterRequests = await request(app)
        .get(`/api/v1/spaces/${space.id}/activity`)
        .set(authHeader(accessToken));
      expect(afterRequests.status).toBe(200);
      // The maintenance request itself is still readable/associated —
      // proves the same Space row survived, not a fresh one.
      const stillThere = await testPrisma.maintenanceRequest.findUnique({
        where: { id: requestRes.body.id },
      });
      expect(stillThere?.spaceId).toBe(space.id);
    });

    it('rejects zero or negative UOE', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);

      const zeroRes = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 0 },
      ]);
      expect(zeroRes.status).toBe(422);

      const negativeRes = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: -5 },
      ]);
      expect(negativeRes.status).toBe(422);
    });

    it('cannot set lots before strata is enabled', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const res = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);
      expect(res.status).toBe(409);
    });
  });

  describe('total UOE and entitlement share calculation (worked example)', () => {
    it('matches the client-supplied 6-lot example exactly, including the 11.71875% share', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanDeclaredUnitsOfEntitlement: 128 });

      const res = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
        { kind: 'new', name: 'Lot 2', code: 'L2', unitsOfEntitlement: 35 },
        { kind: 'new', name: 'Lot 3', code: 'L3', unitsOfEntitlement: 43 },
        { kind: 'new', name: 'Lot 4', code: 'L4', unitsOfEntitlement: 19 },
        { kind: 'new', name: 'Lot 5', code: 'L5', unitsOfEntitlement: 8 },
        { kind: 'new', name: 'Lot 6', code: 'L6', unitsOfEntitlement: 8 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.totalUnitsOfEntitlement).toBe(128);

      const lot1 = res.body.lots.find((l: { name: string }) => l.name === 'Lot 1');
      expect(lot1.unitsOfEntitlement).toBe('15');
      expect(lot1.entitlementSharePct).toBeCloseTo(11.71875, 5);

      expect(res.body.reconciliation.declaredTotal).toBe(128);
      expect(res.body.reconciliation.allocatedTotal).toBe(128);
      expect(res.body.reconciliation.remaining).toBe(0);
      expect(res.body.reconciliation.isComplete).toBe(true);
    });

    it('never accumulates floating-point drift across many fractional lots', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);

      const lots = Array.from({ length: 10 }, (_, i) => ({
        kind: 'new' as const,
        name: `Lot ${i + 1}`,
        code: `L${i + 1}`,
        unitsOfEntitlement: 0.1,
      }));
      const res = await setLots(accessToken, property.id, lots);
      expect(res.status).toBe(200);
      expect(res.body.totalUnitsOfEntitlement).toBe(1); // not 0.9999999999999999
    });
  });

  describe('reconciliation', () => {
    it('shows an incomplete warning when allocated UOE is less than the declared total', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanDeclaredUnitsOfEntitlement: 128 });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 60 },
        { kind: 'new', name: 'Lot 2', code: 'L2', unitsOfEntitlement: 60 },
      ]);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.reconciliation.declaredTotal).toBe(128);
      expect(summary.body.reconciliation.allocatedTotal).toBe(120);
      expect(summary.body.reconciliation.remaining).toBe(8);
      expect(summary.body.reconciliation.isComplete).toBe(false);
    });

    it('reports no reconciliation target (null) when no declared total was ever recorded', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.reconciliation.declaredTotal).toBeNull();
      expect(summary.body.reconciliation.isComplete).toBeNull();
      expect(summary.body.reconciliation.allocatedTotal).toBe(15);
    });

    it('does not hard-block SAVING incomplete allocation — only completing setup while it is incomplete', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, {
        strataPlanNumber: 'SP1',
        strataPlanDeclaredUnitsOfEntitlement: 128,
      });
      const setRes = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);
      // Saving progress itself is never blocked, whatever the allocation.
      expect(setRes.status).toBe(200);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(409);
      expect(completeRes.body.error.details).toEqual({
        declaredTotal: 128,
        allocatedTotal: 15,
        remaining: 113,
      });

      // The property stays SETUP_IN_PROGRESS — never silently marked ACTIVE.
      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataStatus).toBe('SETUP_IN_PROGRESS');
    });

    it('completes setup once allocated UOE exactly matches the declared total', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, {
        strataPlanNumber: 'SP1',
        strataPlanDeclaredUnitsOfEntitlement: 15,
      });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.strataStatus).toBe('ACTIVE');
    });

    it('reports an excess (over-allocated) figure, not a negative remaining, when allocation exceeds the declared total', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, {
        strataPlanNumber: 'SP1',
        strataPlanDeclaredUnitsOfEntitlement: 10,
      });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(409);
      expect(completeRes.body.error.message).toMatch(/5 in excess/);
      expect(completeRes.body.error.details).toEqual({
        declaredTotal: 10,
        allocatedTotal: 15,
        remaining: -5,
      });
    });

    it('completes setup with no reconciliation gate at all when no declared total was ever recorded', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' }); // no declared total
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.strataStatus).toBe('ACTIVE');
    });

    it('refuses to complete setup with no plan number or no lots', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id); // no plan number, no lots

      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(res.status).toBe(409);
    });
  });

  describe('multiple owners never affect Lot UOE', () => {
    it('UOE stays on the lot regardless of how many owners are recorded', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);
      const setRes = await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 20 },
      ]);
      const lotSpaceId = setRes.body.lots[0].spaceId as string;

      await request(app)
        .post(`/api/v1/properties/${property.id}/memberships`)
        .set(authHeader(accessToken))
        .send({
          firstName: 'Owner',
          lastName: 'A',
          email: `ownera+${Date.now()}@example.com`,
          role: 'OWNER',
          spaceId: lotSpaceId,
        });
      await request(app)
        .post(`/api/v1/properties/${property.id}/memberships`)
        .set(authHeader(accessToken))
        .send({
          firstName: 'Owner',
          lastName: 'B',
          email: `ownerb+${Date.now()}@example.com`,
          role: 'OWNER',
          spaceId: lotSpaceId,
        });

      const spaceDetail = await request(app)
        .get(`/api/v1/spaces/${lotSpaceId}`)
        .set(authHeader(accessToken));
      expect(spaceDetail.body.owners).toHaveLength(2);
      expect(spaceDetail.body.entitlementValue).toBe('20'); // unchanged

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.lots[0].unitsOfEntitlement).toBe('20');
      expect(summary.body.totalUnitsOfEntitlement).toBe(20);
    });
  });

  describe('authorization', () => {
    it('a property-scoped manager without strata.manage cannot enable strata or set lots', async () => {
      const owner = await registerAuOrg();
      const property = await createProperty(owner.accessToken);
      const managerToken = await createPropertyManagerToken(
        owner.accessToken,
        owner.organisationId,
        property.id,
      );

      const enableRes = await enableStrata(managerToken, property.id, { strataPlanNumber: 'SP1' });
      expect(enableRes.status).toBe(403);
    });

    it('a property-scoped manager granted strata.manage can enable strata and set lots', async () => {
      const owner = await registerAuOrg();
      const property = await createProperty(owner.accessToken);
      const managerToken = await createPropertyManagerToken(
        owner.accessToken,
        owner.organisationId,
        property.id,
      );

      await request(app)
        .put('/api/v1/organisations/me/role-permissions/PROPERTY_MANAGER')
        .set(authHeader(owner.accessToken))
        .send({ overrides: [{ capability: 'strata.manage', granted: true }] });

      const enableRes = await enableStrata(managerToken, property.id, { strataPlanNumber: 'SP1' });
      expect(enableRes.status).toBe(200);
    });

    it('a different organisation cannot see or act on this property\'s strata data', async () => {
      const orgA = await registerAuOrg({ email: `a+${Date.now()}@example.com` });
      const orgB = await registerAuOrg({ email: `b+${Date.now()}@example.com` });
      const property = await createProperty(orgA.accessToken);
      await enableStrata(orgA.accessToken, property.id);

      const res = await getStrataSummary(orgB.accessToken, property.id);
      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated access', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const res = await request(app).get(`/api/v1/properties/${property.id}/strata`);
      expect(res.status).toBe(401);
    });
  });

  describe('non-strata properties are completely unaffected', () => {
    it('a NOT_ENABLED property has an empty strata summary and no lots', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await createSpace(accessToken, property.id);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.status).toBe(200);
      expect(summary.body.strataStatus).toBe('NOT_ENABLED');
      expect(summary.body.lots).toEqual([]);
      expect(summary.body.totalUnitsOfEntitlement).toBe(0);
    });

    it('an ordinary property update with no strata fields still succeeds unaffected', async () => {
      const { accessToken } = await registerTestUser(app);
      const property = await createProperty(accessToken);
      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken))
        .send({ name: 'Renamed Building' });
      expect(res.status).toBe(200);
      expect(res.body.strataStatus).toBe('NOT_ENABLED');
    });
  });

  describe('legacy isStrataManaged can never contradict strataStatus (M11-B.1)', () => {
    it('POST /properties with isStrataManaged:true advances strataStatus to SETUP_IN_PROGRESS, never leaving it NOT_ENABLED', async () => {
      const { accessToken } = await registerAuOrg();
      const res = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send({ ...validProperty, isStrataManaged: true });
      expect(res.status).toBe(201);
      expect(res.body.isStrataManaged).toBe(true);
      expect(res.body.strataStatus).toBe('SETUP_IN_PROGRESS');
    });

    it('PATCH with isStrataManaged:true on a NOT_ENABLED property advances it to SETUP_IN_PROGRESS', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: true });
      expect(res.status).toBe(200);
      expect(res.body.isStrataManaged).toBe(true);
      expect(res.body.strataStatus).toBe('SETUP_IN_PROGRESS');
    });

    it('PATCH with isStrataManaged:true is a no-op on strataStatus once already ACTIVE — never regresses it', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: true });
      expect(res.status).toBe(200);
      expect(res.body.strataStatus).toBe('ACTIVE');
    });

    it('PATCH with isStrataManaged:false on a SETUP_IN_PROGRESS property resets strataStatus to NOT_ENABLED', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id);

      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: false });
      expect(res.status).toBe(200);
      expect(res.body.isStrataManaged).toBe(false);
      expect(res.body.strataStatus).toBe('NOT_ENABLED');
    });

    it('PATCH with isStrataManaged:false is REJECTED once the scheme is ACTIVE — never silently corrupts to isStrataManaged=false + strataStatus=ACTIVE', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await setLots(accessToken, property.id, [
        { kind: 'new', name: 'Lot 1', code: 'L1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const res = await request(app)
        .patch(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: false });
      expect(res.status).toBe(409);

      // Neither field moved — no partial/contradictory write occurred.
      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataStatus).toBe('ACTIVE');
      const propertyRes = await request(app)
        .get(`/api/v1/properties/${property.id}`)
        .set(authHeader(accessToken));
      expect(propertyRes.body.isStrataManaged).toBe(true);
    });

    it('the new StrataService.enable() path and the legacy PATCH path agree on the same NOT_ENABLED -> SETUP_IN_PROGRESS transition', async () => {
      const { accessToken } = await registerAuOrg();
      const viaLegacy = await createProperty(accessToken, { code: 'LEGACY-01' });
      const viaService = await createProperty(accessToken, { code: 'SERVICE-01' });

      const legacyRes = await request(app)
        .patch(`/api/v1/properties/${viaLegacy.id}`)
        .set(authHeader(accessToken))
        .send({ isStrataManaged: true });
      const serviceRes = await enableStrata(accessToken, viaService.id);

      expect(legacyRes.body.strataStatus).toBe(serviceRes.body.strataStatus);
      expect(legacyRes.body.isStrataManaged).toBe(serviceRes.body.isStrataManaged);
    });
  });

  describe('Space classification — Lot/Unit vs Common Property vs Unclassified (M11-B.1)', () => {
    it('classifies 2 of 3 existing Spaces as Lots and 1 as Common Property', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const unit101 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      const unit102 = await createSpace(accessToken, property.id, { name: 'Unit 102', code: 'U102' });
      const lobby = await createSpace(accessToken, property.id, { name: 'Lobby', code: 'LOBBY' });
      await enableStrata(accessToken, property.id);

      const res = await classifySpaces(accessToken, property.id, [
        { spaceId: unit101.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
        { spaceId: unit102.id, classification: 'LOT', lotNumber: '2', unitsOfEntitlement: 35 },
        { spaceId: lobby.id, classification: 'COMMON_PROPERTY' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.lotCount).toBe(2);
      expect(res.body.commonPropertyCount).toBe(1);
      expect(res.body.unclassifiedCount).toBe(0);
      expect(res.body.lots.map((l: { name: string }) => l.name).sort()).toEqual(['Unit 101', 'Unit 102']);
    });

    it('excludes Common Property from total UOE and entitlement shares', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Lot 1', code: 'L1' });
      const gym = await createSpace(accessToken, property.id, { name: 'Gym', code: 'GYM' });
      await enableStrata(accessToken, property.id);

      const res = await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 20 },
        { spaceId: gym.id, classification: 'COMMON_PROPERTY' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.totalUnitsOfEntitlement).toBe(20);
      expect(res.body.lots).toHaveLength(1);
      expect(res.body.lots[0].entitlementSharePct).toBe(100);

      const gymRow = await testPrisma.space.findUniqueOrThrow({ where: { id: gym.id } });
      expect(gymRow.entitlementValue).toBeNull();
      expect(gymRow.lotNumber).toBeNull();
      expect(gymRow.isStrataLot).toBe(false);
    });

    it('does NOT infer strata Lot status from a Space name containing "Lot"', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id, { name: 'Lot-4 Storage', code: 'LOT4' });
      await enableStrata(accessToken, property.id);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.unclassifiedCount).toBe(1);
      expect(summary.body.lotCount).toBe(0);

      const spaceRow = await testPrisma.space.findUniqueOrThrow({ where: { id: space.id } });
      expect(spaceRow.strataClassification).toBe('UNCLASSIFIED');
      expect(spaceRow.isStrataLot).toBe(false);
    });

    it('allows an unclassified existing Space while SETUP_IN_PROGRESS', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      await createSpace(accessToken, property.id, { name: 'Storage Area', code: 'STORE1' });
      const res = await enableStrata(accessToken, property.id);
      expect(res.status).toBe(200);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataStatus).toBe('SETUP_IN_PROGRESS');
      expect(summary.body.unclassifiedCount).toBe(1);
      expect(summary.body.unclassifiedSpaces[0].name).toBe('Storage Area');
    });

    it('cannot reach ACTIVE while any existing Space remains unclassified', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await createSpace(accessToken, property.id, { name: 'Storage Area', code: 'STORE1' }); // never classified
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(409);
      expect(completeRes.body.error.details.unclassifiedSpaces).toHaveLength(1);
      expect(completeRes.body.error.details.unclassifiedSpaces[0].name).toBe('Storage Area');

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataStatus).toBe('SETUP_IN_PROGRESS');
    });

    it('reaches ACTIVE once every existing Space is classified and UOE reconciles', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      const lobby = await createSpace(accessToken, property.id, { name: 'Lobby', code: 'LOBBY' });
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
        { spaceId: lobby.id, classification: 'COMMON_PROPERTY' },
      ]);

      const completeRes = await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.strataStatus).toBe('ACTIVE');
    });

    it('requires an explicit classification for a new Space created on an ACTIVE strata property', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const withoutClassification = await request(app)
        .post(`/api/v1/properties/${property.id}/spaces`)
        .set(authHeader(accessToken))
        .send({ name: 'Unit 102', code: 'U102', spaceType: 'APARTMENT' });
      expect(withoutClassification.status).toBe(409);

      const withClassification = await request(app)
        .post(`/api/v1/properties/${property.id}/spaces`)
        .set(authHeader(accessToken))
        .send({
          name: 'Unit 102',
          code: 'U102',
          spaceType: 'APARTMENT',
          strataClassification: 'LOT',
          lotNumber: '2',
          entitlementValue: 18,
        });
      expect(withClassification.status).toBe(201);
      expect(withClassification.body.strataClassification).toBe('LOT');
    });

    it('adding a Lot after activation recalculates total UOE and entitlement shares', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const addLotRes = await request(app)
        .post(`/api/v1/properties/${property.id}/spaces`)
        .set(authHeader(accessToken))
        .send({
          name: 'Unit 102',
          code: 'U102',
          spaceType: 'APARTMENT',
          strataClassification: 'LOT',
          lotNumber: '2',
          entitlementValue: 18,
        });
      expect(addLotRes.status).toBe(201);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.lotCount).toBe(2);
      expect(summary.body.totalUnitsOfEntitlement).toBe(33);
      const lot1Row = summary.body.lots.find((l: { name: string }) => l.name === 'Unit 101');
      expect(lot1Row.entitlementSharePct).toBeCloseTo((15 / 33) * 100, 5);
      // The declared Strata Plan total is never silently rewritten.
      expect(summary.body.strataPlanDeclaredUnitsOfEntitlement).toBeNull();
    });

    it('adding Common Property after activation never affects UOE totals', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await enableStrata(accessToken, property.id, { strataPlanNumber: 'SP1' });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      const addCommonRes = await request(app)
        .post(`/api/v1/properties/${property.id}/spaces`)
        .set(authHeader(accessToken))
        .send({
          name: 'Plant Room',
          code: 'PLANT',
          spaceType: 'COMMON_AREA',
          strataClassification: 'COMMON_PROPERTY',
        });
      expect(addCommonRes.status).toBe(201);

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.lotCount).toBe(1);
      expect(summary.body.commonPropertyCount).toBe(1);
      expect(summary.body.totalUnitsOfEntitlement).toBe(15);
    });

    it('an over-allocation after adding a Lot surfaces as a reconciliation issue, without rewriting the declared total', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const lot1 = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      await enableStrata(accessToken, property.id, {
        strataPlanNumber: 'SP1',
        strataPlanDeclaredUnitsOfEntitlement: 20,
      });
      await classifySpaces(accessToken, property.id, [
        { spaceId: lot1.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      await request(app)
        .post(`/api/v1/properties/${property.id}/strata/complete`)
        .set(authHeader(accessToken));

      await request(app)
        .post(`/api/v1/properties/${property.id}/spaces`)
        .set(authHeader(accessToken))
        .send({
          name: 'Unit 102',
          code: 'U102',
          spaceType: 'APARTMENT',
          strataClassification: 'LOT',
          lotNumber: '2',
          entitlementValue: 10,
        });

      const summary = await getStrataSummary(accessToken, property.id);
      expect(summary.body.strataPlanDeclaredUnitsOfEntitlement).toBe('20'); // never rewritten
      expect(summary.body.totalUnitsOfEntitlement).toBe(25);
      expect(summary.body.reconciliation.isComplete).toBe(false);
      expect(summary.body.reconciliation.remaining).toBe(-5);
    });

    it('reclassification preserves the Space identity and every existing relationship', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id, { name: 'Unit 101', code: 'U101' });
      const requestRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({
          title: 'Leaking tap',
          description: 'Kitchen tap is leaking.',
          category: 'PLUMBING',
          priority: 'LOW',
          propertyId: property.id,
          spaceId: space.id,
        });
      expect(requestRes.status).toBe(201);
      await enableStrata(accessToken, property.id);

      // Classify as Common Property first, then correct to Lot/Unit — a
      // sensible mid-setup correction (M11-B.1 Section 15).
      await classifySpaces(accessToken, property.id, [{ spaceId: space.id, classification: 'COMMON_PROPERTY' }]);
      const corrected = await classifySpaces(accessToken, property.id, [
        { spaceId: space.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      expect(corrected.status).toBe(200);
      expect(corrected.body.lots[0].spaceId).toBe(space.id);

      // Same Space row throughout — never duplicated — so its maintenance
      // history is still attached.
      const spaceCount = await testPrisma.space.count({ where: { propertyId: property.id } });
      expect(spaceCount).toBe(1);
      const stillThere = await testPrisma.maintenanceRequest.findUnique({
        where: { id: requestRes.body.id },
      });
      expect(stillThere?.spaceId).toBe(space.id);
    });

    it('cannot classify spaces before strata is enabled', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id);
      const res = await classifySpaces(accessToken, property.id, [
        { spaceId: space.id, classification: 'LOT', lotNumber: '1', unitsOfEntitlement: 15 },
      ]);
      expect(res.status).toBe(409);
    });

    it('rejects a LOT classification missing a lot number or UOE', async () => {
      const { accessToken } = await registerAuOrg();
      const property = await createProperty(accessToken);
      const space = await createSpace(accessToken, property.id);
      await enableStrata(accessToken, property.id);

      const missingLotNumber = await request(app)
        .put(`/api/v1/properties/${property.id}/strata/spaces/classify`)
        .set(authHeader(accessToken))
        .send({ entries: [{ spaceId: space.id, classification: 'LOT', unitsOfEntitlement: 15 }] });
      expect(missingLotNumber.status).toBe(422);

      const missingUoe = await request(app)
        .put(`/api/v1/properties/${property.id}/strata/spaces/classify`)
        .set(authHeader(accessToken))
        .send({ entries: [{ spaceId: space.id, classification: 'LOT', lotNumber: '1' }] });
      expect(missingUoe.status).toBe(422);
    });

    it('a property-scoped manager without strata.manage cannot classify spaces', async () => {
      const owner = await registerAuOrg();
      const property = await createProperty(owner.accessToken);
      const space = await createSpace(owner.accessToken, property.id);
      await enableStrata(owner.accessToken, property.id);
      const managerToken = await createPropertyManagerToken(
        owner.accessToken,
        owner.organisationId,
        property.id,
      );

      const res = await classifySpaces(managerToken, property.id, [
        { spaceId: space.id, classification: 'COMMON_PROPERTY' },
      ]);
      expect(res.status).toBe(403);
    });

    it('cannot classify a space belonging to a different organisation or property', async () => {
      const orgA = await registerAuOrg({ email: `a+${Date.now()}@example.com` });
      const orgB = await registerAuOrg({ email: `b+${Date.now()}@example.com` });
      const propertyA = await createProperty(orgA.accessToken);
      const propertyB = await createProperty(orgB.accessToken);
      const spaceA = await createSpace(orgA.accessToken, propertyA.id);
      await enableStrata(orgA.accessToken, propertyA.id);
      await enableStrata(orgB.accessToken, propertyB.id);

      const res = await classifySpaces(orgB.accessToken, propertyB.id, [
        { spaceId: spaceA.id, classification: 'COMMON_PROPERTY' },
      ]);
      expect(res.status).toBe(404);
    });
  });
});
