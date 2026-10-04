import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser } from '../helpers/auth.js';

const app = createApp();

async function setupPropertyWithTenant(accessToken: string) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send({
      name: 'Manly Cove Villas',
      code: 'MANLY-01',
      addressLine1: '7 The Corso',
      city: 'Manly',
      country: 'Australia',
      propertyType: 'RESIDENTIAL',
    });
  const propertyId = propertyRes.body.id as string;

  await request(app)
    .post(`/api/v1/properties/${propertyId}/memberships`)
    .set(authHeader(accessToken))
    .send({
      email: `resident+${Date.now()}@example.com`,
      firstName: 'Noah',
      lastName: 'Wilson',
      role: 'TENANT',
    });

  return { propertyId };
}

describe('saved audiences', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/saved-audiences');
    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER creating one (RBAC)', async () => {
    const { organisationId, userId } = await registerTestUser(app);
    const memberToken = signAccessToken({
      sub: userId,
      sessionType: 'CUSTOMER',
      organisationId,
      orgRole: 'MEMBER',
    });

    const res = await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(memberToken))
      .send({ name: 'All tenants', criteria: { scope: 'ORGANISATION', roles: ['TENANT'] } });
    expect(res.status).toBe(403);
  });

  it('creates a saved audience and lists it with a live-resolved count', async () => {
    const { accessToken } = await registerTestUser(app);
    await setupPropertyWithTenant(accessToken);

    const created = await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(accessToken))
      .send({ name: 'Manly Cove Tenants', criteria: { scope: 'ORGANISATION', roles: ['TENANT'] } });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/v1/saved-audiences').set(authHeader(accessToken));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].resolvedCount).toBe(1);
    expect(list.body.items[0].name).toBe('Manly Cove Tenants');
  });

  it('the live count changes as real membership changes, since criteria are stored not a frozen list', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId } = await setupPropertyWithTenant(accessToken);

    await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(accessToken))
      .send({ name: 'All tenants', criteria: { scope: 'ORGANISATION', roles: ['TENANT'] } });

    const before = await request(app).get('/api/v1/saved-audiences').set(authHeader(accessToken));
    expect(before.body.items[0].resolvedCount).toBe(1);

    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: `resident2+${Date.now()}@example.com`,
        firstName: 'Charlotte',
        lastName: 'Davis',
        role: 'TENANT',
      });

    const after = await request(app).get('/api/v1/saved-audiences').set(authHeader(accessToken));
    expect(after.body.items[0].resolvedCount).toBe(2);
  });

  it('rejects a duplicate name within the same organisation', async () => {
    const { accessToken } = await registerTestUser(app);

    await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(accessToken))
      .send({ name: 'Portfolio owners', criteria: { scope: 'ORGANISATION', roles: ['OWNER'] } });

    const duplicate = await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(accessToken))
      .send({ name: 'Portfolio owners', criteria: { scope: 'ORGANISATION', roles: ['OWNER'] } });
    expect(duplicate.status).toBe(409);
  });

  it('deletes a saved audience without touching a communication that referenced it', async () => {
    const { accessToken } = await registerTestUser(app);

    const audience = await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(accessToken))
      .send({ name: 'Reusable rule', criteria: { scope: 'ORGANISATION' } });

    const communication = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Uses the saved audience',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
        savedAudienceId: audience.body.id,
      });

    const del = await request(app)
      .delete(`/api/v1/saved-audiences/${audience.body.id}`)
      .set(authHeader(accessToken));
    expect(del.status).toBe(204);

    const stillThere = await request(app)
      .get(`/api/v1/communications/${communication.body.id}`)
      .set(authHeader(accessToken));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.title).toBe('Uses the saved audience');
  });

  it('is organisation-isolated', async () => {
    const orgA = await registerTestUser(app);
    const orgB = await registerTestUser(app);

    await request(app)
      .post('/api/v1/saved-audiences')
      .set(authHeader(orgA.accessToken))
      .send({ name: 'Org A rule', criteria: { scope: 'ORGANISATION' } });

    const list = await request(app)
      .get('/api/v1/saved-audiences')
      .set(authHeader(orgB.accessToken));
    expect(list.body.items).toHaveLength(0);
  });
});
