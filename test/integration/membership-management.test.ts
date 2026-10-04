import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import {
  authHeader,
  createPlainUser,
  registerTestUser,
  residentAccessToken,
} from '../helpers/auth.js';

const app = createApp();

async function createProperty(
  accessToken: string,
  overrides: Partial<{ name: string; code: string }> = {},
) {
  const res = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send({
      name: overrides.name ?? 'Darling Harbour Towers',
      code: overrides.code ?? `DARLING-${Date.now()}`,
      addressLine1: '88 Harbour Street',
      city: 'Sydney',
      country: 'Australia',
      propertyType: 'MIXED_USE',
    });
  return res.body.id as string;
}

async function createSpace(accessToken: string, propertyId: string, code = '803') {
  const res = await request(app)
    .post(`/api/v1/properties/${propertyId}/spaces`)
    .set(authHeader(accessToken))
    .send({ name: `Apartment ${code}`, code, spaceType: 'APARTMENT' });
  return res.body.id as string;
}

describe('membership management', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('assign existing person', () => {
    it('attaches an already-existing contact instead of creating a duplicate', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyA = await createProperty(accessToken, { name: 'Manly Cove Villas' });
      const propertyB = await createProperty(accessToken, { name: 'Surry Hills Apartments' });

      const email = `noah+${Date.now()}@example.com`;
      const first = await request(app)
        .post(`/api/v1/properties/${propertyA}/memberships`)
        .set(authHeader(accessToken))
        .send({ email, firstName: 'Noah', lastName: 'Wilson', role: 'TENANT' });
      const contactId = first.body.contactId as string;

      const searchRes = await request(app)
        .get(`/api/v1/people/contacts/search?search=Noah`)
        .set(authHeader(accessToken));
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.items).toHaveLength(1);
      expect(searchRes.body.items[0].id).toBe(contactId);
      expect(searchRes.body.items[0].memberships[0].property.name).toBe('Manly Cove Villas');

      const assignRes = await request(app)
        .post(`/api/v1/properties/${propertyB}/memberships/assign`)
        .set(authHeader(accessToken))
        .send({ contactId, role: 'OWNER' });
      expect(assignRes.status).toBe(201);
      expect(assignRes.body.contactId).toBe(contactId);

      const contactCount = await testPrisma.propertyContact.count({ where: { id: contactId } });
      expect(contactCount).toBe(1);

      const memberships = await testPrisma.propertyMembership.count({ where: { contactId } });
      expect(memberships).toBe(2);
    });

    it('rejects assigning the same person/role/space combination twice', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyId = await createProperty(accessToken);
      const created = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: `dup+${Date.now()}@example.com`,
          firstName: 'A',
          lastName: 'B',
          role: 'TENANT',
        });

      const dupe = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships/assign`)
        .set(authHeader(accessToken))
        .send({ contactId: created.body.contactId, role: 'TENANT' });
      expect(dupe.status).toBe(409);
    });
  });

  describe('update membership', () => {
    it('changes role and moves to a different space', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyId = await createProperty(accessToken);
      const spaceA = await createSpace(accessToken, propertyId, '803');
      const spaceB = await createSpace(accessToken, propertyId, '804');

      const membership = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: `move+${Date.now()}@example.com`,
          firstName: 'James',
          lastName: 'Nguyen',
          role: 'TENANT',
          spaceId: spaceA,
        });

      const updated = await request(app)
        .patch(`/api/v1/people/memberships/${membership.body.id}`)
        .set(authHeader(accessToken))
        .send({ role: 'RESIDENT', spaceId: spaceB });
      expect(updated.status).toBe(200);
      expect(updated.body.role).toBe('RESIDENT');
      expect(updated.body.spaceId).toBe(spaceB);

      const activity = await testPrisma.activityEvent.findFirst({
        where: { entityId: membership.body.id, eventType: 'MEMBERSHIP_UPDATED' },
      });
      expect(activity).not.toBeNull();
    });

    it('rejects a space that does not belong to the membership’s property', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyId = await createProperty(accessToken);
      const otherPropertyId = await createProperty(accessToken, { name: 'Other' });
      const otherSpace = await createSpace(accessToken, otherPropertyId, '1');

      const membership = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: `x+${Date.now()}@example.com`,
          firstName: 'A',
          lastName: 'B',
          role: 'TENANT',
        });

      const res = await request(app)
        .patch(`/api/v1/people/memberships/${membership.body.id}`)
        .set(authHeader(accessToken))
        .send({ spaceId: otherSpace });
      expect(res.status).toBe(404);
    });
  });

  describe('end membership + resident access', () => {
    it('ends a membership (soft, not deleted) and the resident immediately loses access to that property', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const propertyId = await createProperty(accessToken);
      const spaceId = await createSpace(accessToken, propertyId);

      const resident = await createPlainUser();
      const membership = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
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

      // Before ending: resident sees the membership and can report an issue.
      const before = await request(app).get('/api/v1/people/me').set(authHeader(residentToken));
      expect(before.body.items).toHaveLength(1);

      const reportBefore = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(residentToken))
        .send({
          propertyId,
          spaceId,
          title: 'Leaking tap',
          description: 'Kitchen tap leaking',
          category: 'PLUMBING',
          priority: 'LOW',
        });
      expect(reportBefore.status).toBe(201);

      const endRes = await request(app)
        .post(`/api/v1/people/memberships/${membership.body.id}/end`)
        .set(authHeader(accessToken));
      expect(endRes.status).toBe(200);
      expect(endRes.body.status).toBe('ENDED');
      expect(endRes.body.endDate).not.toBeNull();

      // Soft-ended, never deleted.
      const stillExists = await testPrisma.propertyMembership.findUnique({
        where: { id: membership.body.id },
      });
      expect(stillExists).not.toBeNull();
      expect(stillExists?.status).toBe('ENDED');

      const activity = await testPrisma.activityEvent.findFirst({
        where: { entityId: membership.body.id, eventType: 'MEMBERSHIP_ENDED' },
      });
      expect(activity).not.toBeNull();

      const notification = await testPrisma.notification.findFirst({
        where: { userId: resident.userId, organisationId },
      });
      expect(notification?.title).toContain('access');

      // After ending: no longer listed, and can no longer report a new
      // issue against this property — access is recalculated immediately
      // purely from the ACTIVE-only query filters already in place.
      const after = await request(app).get('/api/v1/people/me').set(authHeader(residentToken));
      expect(after.body.items).toHaveLength(0);

      const reportAfter = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(residentToken))
        .send({
          propertyId,
          spaceId,
          title: 'Another issue',
          description: 'Should be blocked',
          category: 'PLUMBING',
          priority: 'LOW',
        });
      expect(reportAfter.status).toBe(403);
    });

    it('ending one of two memberships leaves the other fully intact (multi-membership)', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const propertyA = await createProperty(accessToken, { name: 'Property A' });
      const propertyB = await createProperty(accessToken, { name: 'Property B' });

      const resident = await createPlainUser();
      const membershipA = await request(app)
        .post(`/api/v1/properties/${propertyA}/memberships`)
        .set(authHeader(accessToken))
        .send({ email: resident.email, firstName: 'Resi', lastName: 'Dent', role: 'TENANT' });
      await request(app)
        .post(`/api/v1/properties/${propertyB}/memberships/assign`)
        .set(authHeader(accessToken))
        .send({ contactId: membershipA.body.contactId, role: 'OWNER' });

      const contact = await testPrisma.propertyContact.findFirst({
        where: { email: resident.email },
      });
      const residentToken = residentAccessToken(resident.userId, organisationId, contact!.id);

      await request(app)
        .post(`/api/v1/people/memberships/${membershipA.body.id}/end`)
        .set(authHeader(accessToken));

      const memberships = await request(app)
        .get('/api/v1/people/me')
        .set(authHeader(residentToken));
      expect(memberships.body.items).toHaveLength(1);
      expect(memberships.body.items[0].property.name).toBe('Property B');
      expect(memberships.body.items[0].role).toBe('OWNER');
    });

    it('cannot end an already-ended membership, or change its role/space', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyId = await createProperty(accessToken);
      const membership = await request(app)
        .post(`/api/v1/properties/${propertyId}/memberships`)
        .set(authHeader(accessToken))
        .send({
          email: `once+${Date.now()}@example.com`,
          firstName: 'A',
          lastName: 'B',
          role: 'TENANT',
        });

      await request(app)
        .post(`/api/v1/people/memberships/${membership.body.id}/end`)
        .set(authHeader(accessToken));

      const endAgain = await request(app)
        .post(`/api/v1/people/memberships/${membership.body.id}/end`)
        .set(authHeader(accessToken));
      expect(endAgain.status).toBe(409);

      const updateAfterEnd = await request(app)
        .patch(`/api/v1/people/memberships/${membership.body.id}`)
        .set(authHeader(accessToken))
        .send({ role: 'OWNER' });
      expect(updateAfterEnd.status).toBe(409);
    });
  });
});
