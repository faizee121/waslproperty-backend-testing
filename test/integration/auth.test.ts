import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlainUser } from '../helpers/auth.js';
import { buildPublicReference } from '../../src/lib/public-reference.js';

const app = createApp();

const validRegisterBody = {
  organisationName: 'Marina Heights Management',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  password: 'super-secret-1',
};

describe('auth flow', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('registers a new organisation + owner user', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validRegisterBody);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('jane@example.com');
    expect(res.body.organisation.name).toBe('Marina Heights Management');
    expect(res.body.organisation.slug).toBe('marina-heights-management');
    expect(res.body.orgRole).toBe('OWNER');
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.headers['set-cookie']?.[0]).toMatch(/wasl_property_refresh_token=/);
  });

  it('defaults a new organisation to AUD when no currency is given', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    expect(res.status).toBe(201);
    const me = await request(app)
      .get('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.body.currencyCode).toBe('AUD');
  });

  it('respects an explicitly selected currency at registration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegisterBody, currencyCode: 'GBP' });
    expect(res.status).toBe(201);
    const me = await request(app)
      .get('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.body.currencyCode).toBe('GBP');
  });

  it('rejects an unsupported currency code at registration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegisterBody, currencyCode: 'ZZZ' });
    expect(res.status).toBe(422);
  });

  it('rejects registering the same email twice', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const res = await request(app).post('/api/v1/auth/register').send(validRegisterBody);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid registration payloads', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validRegisterBody, email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with correct credentials', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegisterBody);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: validRegisterBody.email, password: validRegisterBody.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
  });

  it('rejects login with the wrong password', async () => {
    await request(app).post('/api/v1/auth/register').send(validRegisterBody);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: validRegisterBody.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const cookie = registerRes.headers['set-cookie'][0];

    const refreshRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeTypeOf('string');
    // The rotated refresh cookie must differ from the one just used.
    expect(refreshRes.headers['set-cookie'][0]).not.toBe(cookie);

    // The old refresh token must be revoked (rotation) and no longer usable.
    const reuseRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(reuseRes.status).toBe(401);
  });

  it('logs out and revokes the refresh token', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const cookie = registerRes.headers['set-cookie'][0];

    const logoutRes = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshRes.status).toBe(401);
  });

  it('rejects refresh with no cookie at all', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('GET /organisations/me', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/organisations/me');
    expect(res.status).toBe(401);
  });

  it('returns the caller organisation and role', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);

    const res = await request(app)
      .get('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${registerRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Marina Heights Management');
    expect(res.body.orgRole).toBe('OWNER');
  });

  it('rejects a tenant-isolation-breaking tampered token', async () => {
    const res = await request(app)
      .get('/api/v1/organisations/me')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
  });
});

describe('PATCH /organisations/me — currency', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('lets an OWNER change the organisation currency', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const res = await request(app)
      .patch('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${registerRes.body.accessToken}`)
      .send({ currencyCode: 'USD' });
    expect(res.status).toBe(200);
    expect(res.body.currencyCode).toBe('USD');
  });

  it('rejects an unsupported currency code', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const res = await request(app)
      .patch('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${registerRes.body.accessToken}`)
      .send({ currencyCode: 'NOTREAL' });
    expect(res.status).toBe(422);
  });

  it('rejects a MEMBER changing the organisation currency (OWNER/ADMIN only)', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const organisationId = registerRes.body.organisation.id as string;

    const memberEmail = `member+${Date.now()}@example.com`;
    const { userId: memberUserId } = await createPlainUser({ email: memberEmail });
    await testPrisma.organisationMembership.create({
      data: { organisationId, userId: memberUserId, role: 'MEMBER' },
    });
    const memberLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: memberEmail, password: 'resident-secret-1' });
    expect(memberLogin.body.accessToken).toBeTypeOf('string');

    const res = await request(app)
      .patch('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${memberLogin.body.accessToken}`)
      .send({ currencyCode: 'USD' });
    expect(res.status).toBe(403);
  });

  it('changing the organisation currency never mutates an already-created financial record', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const token = registerRes.body.accessToken as string;
    const organisationId = registerRes.body.organisation.id as string;

    const property = await testPrisma.property.create({
      data: {
        organisationId,
        publicReference: buildPublicReference('PROP'),
        name: 'Currency Test Property',
        code: `CUR-${Date.now()}`,
        addressLine1: '1 St',
        city: 'Sydney',
        country: 'Australia',
        propertyType: 'RESIDENTIAL',
      },
    });
    const request_ = await testPrisma.maintenanceRequest.create({
      data: {
        organisationId,
        publicReference: buildPublicReference('MR'),
        propertyId: property.id,
        title: 'Leak',
        description: 'test',
        category: 'PLUMBING',
        priority: 'LOW',
      },
    });
    const workOrderRes = await request(app)
      .post('/api/v1/work-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        maintenanceRequestId: request_.id,
        title: 'Fix leak',
        description: 'test',
        priority: 'LOW',
      });
    expect(workOrderRes.status).toBe(201);
    expect(workOrderRes.body.currencyCode).toBe('AUD');

    const patchRes = await request(app)
      .patch('/api/v1/organisations/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currencyCode: 'EUR' });
    expect(patchRes.status).toBe(200);

    const workOrderAfter = await testPrisma.workOrder.findUniqueOrThrow({
      where: { id: workOrderRes.body.id },
    });
    expect(workOrderAfter.currencyCode).toBe('AUD');
  });
});

describe('resident login (M6)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('logs in a User with no OrganisationMembership but a linked PropertyContact as a resident', async () => {
    const registerRes = await request(app).post('/api/v1/auth/register').send(validRegisterBody);
    const ownerToken = registerRes.body.accessToken as string;
    const organisationId = registerRes.body.organisation.id as string;

    const propertyRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(ownerToken))
      .send({
        name: 'Wasl Heights',
        code: 'WASL-HTS',
        addressLine1: '1 Wasl Blvd',
        city: 'Dubai',
        country: 'UAE',
        propertyType: 'MIXED_USE',
      });
    const spaceRes = await request(app)
      .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
      .set(authHeader(ownerToken))
      .send({ name: 'Office 1204', code: '1204', spaceType: 'OFFICE' });

    // Pre-condition: a plain login already exists for this email (no
    // self-service resident sign-up exists yet in M6).
    const resident = await createPlainUser({ email: 'tara.tenant@example.com' });

    // Adding the person links the pre-existing User by email match — the
    // existing M4 behaviour, unmodified.
    await request(app)
      .post(`/api/v1/properties/${propertyRes.body.id}/memberships`)
      .set(authHeader(ownerToken))
      .send({
        email: resident.email,
        firstName: 'Tara',
        lastName: 'Tenant',
        role: 'TENANT',
        spaceId: spaceRes.body.id,
      });

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: resident.email, password: resident.password });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.orgRole).toBeNull();
    expect(loginRes.body.accountType).toBe('resident');
    expect(loginRes.body.organisation.id).toBe(organisationId);

    const meRes = await request(app)
      .get('/api/v1/organisations/me')
      .set(authHeader(loginRes.body.accessToken));
    expect(meRes.body.accountType).toBe('resident');
    expect(meRes.body.orgRole).toBeNull();
  });

  it('rejects login for a User with neither a membership nor a linked contact', async () => {
    const resident = await createPlainUser();

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: resident.email, password: resident.password });

    expect(res.status).toBe(401);
  });
});
