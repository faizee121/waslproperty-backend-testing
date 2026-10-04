import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/lib/tokens.js';
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
  name: 'Office 1204',
  code: '1204',
  spaceType: 'OFFICE',
};

async function setupPropertyAndSpace(accessToken: string) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send(validProperty);
  const spaceRes = await request(app)
    .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
    .set(authHeader(accessToken))
    .send(validSpace);
  return { propertyId: propertyRes.body.id as string, spaceId: spaceRes.body.id as string };
}

describe('people / property memberships', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/properties/does-not-matter/memberships');
    expect(res.status).toBe(401);
  });

  it('adds an owner to a space and returns the membership with contact + space', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'owner@example.com',
        firstName: 'Omar',
        lastName: 'Owner',
        role: 'OWNER',
        spaceId,
      });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('OWNER');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.contact.email).toBe('owner@example.com');
    expect(res.body.space.id).toBe(spaceId);
  });

  it('adds a property-level manager without a space', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId } = await setupPropertyAndSpace(accessToken);

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'manager@example.com',
        firstName: 'Mona',
        lastName: 'Manager',
        role: 'PROPERTY_MANAGER',
      });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('PROPERTY_MANAGER');
    expect(res.body.space).toBeNull();
  });

  it('rejects a space that does not belong to the given property', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId } = await setupPropertyAndSpace(accessToken);

    const otherPropertyRes = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send({ ...validProperty, code: 'OTHER-CODE' });
    const otherSpaceRes = await request(app)
      .post(`/api/v1/properties/${otherPropertyRes.body.id}/spaces`)
      .set(authHeader(accessToken))
      .send(validSpace);

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'tenant@example.com',
        firstName: 'Tara',
        lastName: 'Tenant',
        role: 'TENANT',
        spaceId: otherSpaceRes.body.id,
      });

    expect(res.status).toBe(404);
  });

  it('rejects adding a person to a property from another organisation (tenant isolation)', async () => {
    const orgA = await registerTestUser(app);
    const orgB = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(orgA.accessToken);

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(orgB.accessToken))
      .send({ email: 'x@example.com', firstName: 'X', lastName: 'Y', role: 'TENANT', spaceId });

    expect(res.status).toBe(404);
  });

  it('rejects a MEMBER adding a person but allows listing (RBAC)', async () => {
    const { organisationId, userId } = await registerTestUser(app);
    const ownerToken = signAccessToken({
      sub: userId,
      sessionType: 'CUSTOMER',
      organisationId,
      orgRole: 'OWNER',
    });
    const { propertyId } = await setupPropertyAndSpace(ownerToken);
    const memberToken = signAccessToken({
      sub: userId,
      sessionType: 'CUSTOMER',
      organisationId,
      orgRole: 'MEMBER',
    });

    const listRes = await request(app)
      .get(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(memberToken));
    expect(listRes.status).toBe(200);

    const addRes = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(memberToken))
      .send({ email: 'x@example.com', firstName: 'X', lastName: 'Y', role: 'PROPERTY_MANAGER' });
    expect(addRes.status).toBe(403);
  });

  it('reuses the same contact for repeated emails instead of duplicating', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);

    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'dual@example.com',
        firstName: 'Dana',
        lastName: 'Dual',
        role: 'OWNER',
        spaceId,
      });

    // Same person, added again under a different role — should reuse the contact record.
    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'dual@example.com',
        firstName: 'Dana',
        lastName: 'Dual',
        role: 'PROPERTY_MANAGER',
      });

    const contacts = await testPrisma.propertyContact.findMany({
      where: { email: 'dual@example.com' },
    });
    expect(contacts).toHaveLength(1);

    const memberships = await testPrisma.propertyMembership.findMany({
      where: { contactId: contacts[0]!.id },
    });
    expect(memberships).toHaveLength(2);
  });

  it('links an existing Wasl Property user by email instead of creating a duplicate identity', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);
    const secondOrgUser = await registerTestUser(app, { email: 'linked-user@example.com' });

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: 'linked-user@example.com',
        firstName: 'Linked',
        lastName: 'User',
        role: 'RESIDENT',
        spaceId,
      });

    expect(res.status).toBe(201);
    const contact = await testPrisma.propertyContact.findUnique({
      where: { id: res.body.contact.id },
    });
    expect(contact?.userId).toBe(secondOrgUser.userId);
  });

  it('auto-links a person even when their email is already a portal identity in another organisation', async () => {
    // PropertyContact.userId is unique per organisation, not globally — a
    // User may be the property-scoped portal identity for at most one
    // contact *within a given organisation*, but for one contact in each
    // of several different organisations at once (e.g. staff/manager at
    // Org A who is also a resident at Org B). Adding this person to a
    // second organisation must auto-link there too, independently of the
    // first link, never degrade to an orphaned contact.
    const orgA = await registerTestUser(app);
    const { propertyId: propertyAId, spaceId: spaceAId } = await setupPropertyAndSpace(
      orgA.accessToken,
    );
    const existingUser = await createPlainUser();
    const sharedEmail = existingUser.email;
    const firstLinkRes = await request(app)
      .post(`/api/v1/properties/${propertyAId}/memberships`)
      .set(authHeader(orgA.accessToken))
      .send({
        email: sharedEmail,
        firstName: 'Already',
        lastName: 'Linked',
        role: 'RESIDENT',
        spaceId: spaceAId,
      });
    const linkedUserId = firstLinkRes.body.contact.userId as string;
    expect(linkedUserId).toBe(existingUser.userId);

    const orgB = await registerTestUser(app);
    const { propertyId: propertyBId } = await setupPropertyAndSpace(orgB.accessToken);

    const secondRes = await request(app)
      .post(`/api/v1/properties/${propertyBId}/memberships`)
      .set(authHeader(orgB.accessToken))
      .send({ email: sharedEmail, firstName: 'Already', lastName: 'Linked', role: 'OWNER' });

    expect(secondRes.status).toBe(201);
    // Auto-linked independently in Org B — a real, second portal identity
    // for the same underlying User, not a shared/merged one.
    expect(secondRes.body.contact.userId).toBe(linkedUserId);

    const orgAContact = await testPrisma.propertyContact.findFirst({
      where: { organisationId: orgA.organisationId, email: sharedEmail },
    });
    expect(orgAContact?.userId).toBe(linkedUserId);
  });

  it('rejects duplicate active memberships for the same contact/property/space/role', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);
    const payload = {
      email: 'repeat@example.com',
      firstName: 'Rita',
      lastName: 'Repeat',
      role: 'TENANT',
      spaceId,
    };

    const first = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send(payload);
    expect(second.status).toBe(409);
  });

  it('lists people scoped to a property and to a specific space', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);

    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({ email: 'a@example.com', firstName: 'A', lastName: 'A', role: 'OWNER', spaceId });
    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({ email: 'b@example.com', firstName: 'B', lastName: 'B', role: 'PROPERTY_MANAGER' });

    const propertyPeople = await request(app)
      .get(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken));
    expect(propertyPeople.body.total).toBe(2);

    const spacePeople = await request(app)
      .get(`/api/v1/spaces/${spaceId}/memberships`)
      .set(authHeader(accessToken));
    expect(spacePeople.body.total).toBe(1);
    expect(spacePeople.body.items[0].contact.email).toBe('a@example.com');
  });

  describe('occupancy derivation', () => {
    it('is VACANT with no active tenant/resident membership and OCCUPIED once one exists', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);

      const before = await request(app)
        .get(`/api/v1/spaces/${spaceId}`)
        .set(authHeader(accessToken));
      expect(before.body.occupancy).toBe('VACANT');

      // An OWNER membership alone should not flip occupancy.
      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: 'owner2@example.com',
          firstName: 'O',
          lastName: 'O',
          role: 'OWNER',
          spaceId,
        });

      const afterOwner = await request(app)
        .get(`/api/v1/spaces/${spaceId}`)
        .set(authHeader(accessToken));
      expect(afterOwner.body.occupancy).toBe('VACANT');

      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: 'tenant2@example.com',
          firstName: 'T',
          lastName: 'T',
          role: 'TENANT',
          spaceId,
        });

      const afterTenant = await request(app)
        .get(`/api/v1/spaces/${spaceId}`)
        .set(authHeader(accessToken));
      expect(afterTenant.body.occupancy).toBe('OCCUPIED');

      const listRes = await request(app)
        .get(`/api/v1/properties/${propertyId}/spaces`)
        .set(authHeader(accessToken));
      expect(listRes.body.items[0].occupancy).toBe('OCCUPIED');
    });
  });

  describe('people directory', () => {
    it('searches and filters across the organisation', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyAndSpace(accessToken);

      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: 'searchable@example.com',
          firstName: 'Searchable',
          lastName: 'Person',
          role: 'TENANT',
          spaceId,
        });
      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: 'other@example.com',
          firstName: 'Other',
          lastName: 'Person',
          role: 'AGENT',
        });

      const bySearch = await request(app)
        .get('/api/v1/people?search=Searchable')
        .set(authHeader(accessToken));
      expect(bySearch.body.total).toBe(1);
      expect(bySearch.body.items[0].contact.email).toBe('searchable@example.com');

      const byRole = await request(app)
        .get('/api/v1/people?role=AGENT')
        .set(authHeader(accessToken));
      expect(byRole.body.total).toBe(1);
      expect(byRole.body.items[0].role).toBe('AGENT');

      const byProperty = await request(app)
        .get(`/api/v1/people?propertyId=${propertyId}`)
        .set(authHeader(accessToken));
      expect(byProperty.body.total).toBe(2);
    });

    it('does not leak another organisation people into the directory', async () => {
      const orgA = await registerTestUser(app);
      const orgB = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyAndSpace(orgA.accessToken);

      await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(orgA.accessToken))
        .send({
          email: 'a-only@example.com',
          firstName: 'A',
          lastName: 'Only',
          role: 'OWNER',
          spaceId,
        });

      const res = await request(app).get('/api/v1/people').set(authHeader(orgB.accessToken));
      expect(res.body.total).toBe(0);
    });
  });
});
