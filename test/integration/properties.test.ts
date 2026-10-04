import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import {
  authHeader,
  createPlainUser,
  registerTestUser,
  residentAccessToken,
} from '../helpers/auth.js';

const app = createApp();

const validProperty = {
  name: 'Marina Heights',
  code: 'MARINA-HT',
  addressLine1: '1 Marina Blvd',
  city: 'Dubai',
  country: 'UAE',
  propertyType: 'MIXED_USE',
};

describe('properties', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/properties');
    expect(res.status).toBe(401);
  });

  it('creates a property scoped to the caller organisation', async () => {
    const { accessToken } = await registerTestUser(app);

    const res = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Marina Heights');
    expect(res.body.code).toBe('MARINA-HT');
    expect(res.body.status).toBe('ACTIVE');
  });

  it('rejects invalid payloads', async () => {
    const { accessToken } = await registerTestUser(app);

    const res = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send({ ...validProperty, propertyType: 'NOT_A_TYPE' });

    expect(res.status).toBe(422);
  });

  it('allows a MEMBER to list properties but rejects a MEMBER creating one (RBAC)', async () => {
    const { organisationId, userId } = await registerTestUser(app);
    const memberToken = signAccessToken({
      sub: userId,
      sessionType: 'CUSTOMER',
      organisationId,
      orgRole: 'MEMBER',
    });

    const listRes = await request(app).get('/api/v1/properties').set(authHeader(memberToken));
    expect(listRes.status).toBe(200);

    const createRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(memberToken))
      .send(validProperty);
    expect(createRes.status).toBe(403);
  });

  it('prevents duplicate property codes within the same organisation', async () => {
    const { accessToken } = await registerTestUser(app);
    await request(app).post('/api/v1/properties').set(authHeader(accessToken)).send(validProperty);

    const res = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    expect(res.status).toBe(409);
  });

  it('lists only the caller organisation properties (tenant isolation)', async () => {
    const orgA = await registerTestUser(app);
    const orgB = await registerTestUser(app);

    await request(app)
      .post('/api/v1/properties')
      .set(authHeader(orgA.accessToken))
      .send(validProperty);
    await request(app)
      .post('/api/v1/properties')
      .set(authHeader(orgB.accessToken))
      .send({ ...validProperty, code: 'OTHER-CODE' });

    const res = await request(app).get('/api/v1/properties').set(authHeader(orgA.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].code).toBe('MARINA-HT');
  });

  it('returns 404 when reading a property that belongs to another organisation', async () => {
    const orgA = await registerTestUser(app);
    const orgB = await registerTestUser(app);

    const createRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(orgA.accessToken))
      .send(validProperty);

    const res = await request(app)
      .get(`/api/v1/properties/${createRes.body.id}`)
      .set(authHeader(orgB.accessToken));

    expect(res.status).toBe(404);
  });

  it('returns a property 360 view including its space count', async () => {
    const { accessToken } = await registerTestUser(app);
    const createRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    await request(app)
      .post(`/api/v1/properties/${createRes.body.id}/spaces`)
      .set(authHeader(accessToken))
      .send({ name: 'Apartment 1204', code: '1204', spaceType: 'APARTMENT' });

    const res = await request(app)
      .get(`/api/v1/properties/${createRes.body.id}`)
      .set(authHeader(accessToken));

    expect(res.status).toBe(200);
    expect(res.body._count.spaces).toBe(1);
  });

  it('updates a property', async () => {
    const { accessToken } = await registerTestUser(app);
    const createRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    const res = await request(app)
      .patch(`/api/v1/properties/${createRes.body.id}`)
      .set(authHeader(accessToken))
      .send({ name: 'Marina Heights Tower', status: 'INACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Marina Heights Tower');
    expect(res.body.status).toBe('INACTIVE');
  });

  describe('GET /properties/:id/insights', () => {
    let insightsPropertyCodeCounter = 0;

    async function setupPropertyWithSpace(accessToken: string) {
      const code = `MARINA-${++insightsPropertyCodeCounter}`;
      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send({ ...validProperty, code });
      const spaceRes = await request(app)
        .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
        .set(authHeader(accessToken))
        .send({ name: 'Apartment 1204', code: '1204', spaceType: 'APARTMENT' });
      return { propertyId: propertyRes.body.id as string, spaceId: spaceRes.body.id as string };
    }

    it('requires authentication', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId } = await setupPropertyWithSpace(accessToken);
      const res = await request(app).get(`/api/v1/properties/${propertyId}/insights`);
      expect(res.status).toBe(401);
    });

    it('denies a resident', async () => {
      const { accessToken: ownerToken, organisationId } = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyWithSpace(ownerToken);
      const resident = await createPlainUser();
      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(ownerToken))
        .send({
          email: resident.email,
          firstName: 'Resi',
          lastName: 'Dent',
          role: 'TENANT',
          spaceId,
        });
      const contact = await testPrisma.propertyContact.findFirst({
        where: { email: resident.email },
      });
      const residentToken = residentAccessToken(resident.userId, organisationId, contact!.id);

      const res = await request(app)
        .get(`/api/v1/properties/${propertyId}/insights`)
        .set(authHeader(residentToken));
      expect(res.status).toBe(403);
    });

    it('returns 404 for a property in another organisation', async () => {
      const orgA = await registerTestUser(app);
      const orgB = await registerTestUser(app);
      const { propertyId } = await setupPropertyWithSpace(orgA.accessToken);

      const res = await request(app)
        .get(`/api/v1/properties/${propertyId}/insights`)
        .set(authHeader(orgB.accessToken));
      expect(res.status).toBe(404);
    });

    it('scopes openRequests, averageResolutionHours and attention to this property only', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyWithSpace(accessToken);
      const other = await setupPropertyWithSpace(accessToken);

      // This property: one open urgent request (aged past 24h -> CRITICAL),
      // one resolved request with a known resolution time.
      const urgentRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({
          title: 'Lift stuck',
          description: 'Lift stuck between floors.',
          category: 'COMMON_AREA',
          priority: 'URGENT',
          propertyId,
          spaceId,
        });
      await testPrisma.maintenanceRequest.update({
        where: { id: urgentRes.body.id },
        data: { reportedAt: new Date(Date.now() - 25 * 3_600_000) },
      });

      const resolvedRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({
          title: 'Leaking tap',
          description: 'Kitchen tap leaking.',
          category: 'PLUMBING',
          priority: 'LOW',
          propertyId,
          spaceId,
        });
      const now = Date.now();
      await testPrisma.maintenanceRequest.update({
        where: { id: resolvedRes.body.id },
        data: {
          reportedAt: new Date(now - 10 * 3_600_000),
          status: 'RESOLVED',
          resolvedAt: new Date(now),
        },
      });

      // A different property in the same org: must never leak into this property's insights.
      await request(app).post('/api/v1/maintenance-requests').set(authHeader(accessToken)).send({
        title: 'Other property urgent issue',
        description: 'Should not appear.',
        category: 'SECURITY',
        priority: 'URGENT',
        propertyId: other.propertyId,
        spaceId: other.spaceId,
      });
      await testPrisma.maintenanceRequest.updateMany({
        where: { propertyId: other.propertyId },
        data: { reportedAt: new Date(Date.now() - 30 * 3_600_000) },
      });

      const res = await request(app)
        .get(`/api/v1/properties/${propertyId}/insights`)
        .set(authHeader(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.metrics.openRequests).toBe(1); // only the urgent one — resolved excluded
      expect(res.body.metrics.averageResolutionHours).toBe(10);
      expect(res.body.attention.items).toHaveLength(1);
      expect(res.body.attention.items[0].type).toBe('URGENT_REQUEST_OPEN');
      expect(res.body.attention.items[0].propertyId).toBe(propertyId);
    });

    it('returns null averageResolutionHours when nothing has been resolved', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId } = await setupPropertyWithSpace(accessToken);

      const res = await request(app)
        .get(`/api/v1/properties/${propertyId}/insights`)
        .set(authHeader(accessToken));

      expect(res.status).toBe(200);
      expect(res.body.metrics.openRequests).toBe(0);
      expect(res.body.metrics.averageResolutionHours).toBeNull();
      expect(res.body.attention.items).toEqual([]);
    });
  });
});
