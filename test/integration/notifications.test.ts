import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser } from '../helpers/auth.js';

const app = createApp();

describe('notifications', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('lists only the caller’s own notifications, unread-first ordering by recency', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    const other = await registerTestUser(app, { organisationName: 'Other Org' });

    await testPrisma.notification.create({
      data: { organisationId, userId, title: 'First' },
    });
    await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Second' },
    });
    await testPrisma.notification.create({
      data: { organisationId: other.organisationId, userId: other.userId, title: 'Not mine' },
    });

    const res = await request(app).get('/api/v1/notifications').set(authHeader(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual(['Second', 'First']);
  });

  it('unread-count reflects only unread rows for the caller', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    const n1 = await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Unread one' },
    });
    await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Already read', readAt: new Date() },
    });

    const before = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(authHeader(accessToken));
    expect(before.body.count).toBe(1);

    await request(app).post(`/api/v1/notifications/${n1.id}/read`).set(authHeader(accessToken));

    const after = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(authHeader(accessToken));
    expect(after.body.count).toBe(0);
  });

  it('cannot mark another user’s notification as read', async () => {
    const { organisationId, userId } = await registerTestUser(app);
    const other = await registerTestUser(app, { organisationName: 'Other Org 2' });

    const notification = await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Mine' },
    });

    const res = await request(app)
      .post(`/api/v1/notifications/${notification.id}/read`)
      .set(authHeader(other.accessToken));
    expect(res.status).toBe(404);
  });

  it('mark-all-read only touches the caller’s own unread notifications', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    const other = await registerTestUser(app, { organisationName: 'Other Org 3' });

    await testPrisma.notification.createMany({
      data: [
        { organisationId, userId, title: 'A' },
        { organisationId, userId, title: 'B' },
        {
          organisationId: other.organisationId,
          userId: other.userId,
          title: 'Not mine',
        },
      ],
    });

    const res = await request(app)
      .post('/api/v1/notifications/read-all')
      .set(authHeader(accessToken));
    expect(res.body.count).toBe(2);

    const otherUnread = await testPrisma.notification.count({
      where: { userId: other.userId, readAt: null },
    });
    expect(otherUnread).toBe(1);
  });

  it('unreadOnly filter returns only unread rows', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    await testPrisma.notification.create({ data: { organisationId, userId, title: 'Unread' } });
    await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Read', readAt: new Date() },
    });

    const res = await request(app)
      .get('/api/v1/notifications?unreadOnly=true')
      .set(authHeader(accessToken));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Unread');
  });

  it('an explicit unreadOnly=false still returns every notification, not just unread ones', async () => {
    // Regression test: query params are always strings, and Boolean("false")
    // is true in JS — a naive z.coerce.boolean() would silently treat this
    // as unreadOnly=true and hide already-read notifications.
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    await testPrisma.notification.create({ data: { organisationId, userId, title: 'Unread' } });
    await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Read', readAt: new Date() },
    });

    const res = await request(app)
      .get('/api/v1/notifications?unreadOnly=false')
      .set(authHeader(accessToken));
    expect(res.body.items).toHaveLength(2);
  });

  it('entityType filter returns only notifications for that entity type', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    await testPrisma.notification.create({
      data: {
        organisationId,
        userId,
        title: 'An announcement',
        entityType: 'Communication',
        entityId: 'some-communication-id',
      },
    });
    await testPrisma.notification.create({
      data: {
        organisationId,
        userId,
        title: 'A maintenance update',
        entityType: 'MaintenanceRequest',
        entityId: 'some-request-id',
      },
    });

    const res = await request(app)
      .get('/api/v1/notifications?entityType=Communication')
      .set(authHeader(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('An announcement');
  });

  it('fetches a single notification by id, scoped to the caller', async () => {
    const { accessToken, organisationId, userId } = await registerTestUser(app);
    const other = await registerTestUser(app, { organisationName: 'Other Org 4' });

    const notification = await testPrisma.notification.create({
      data: { organisationId, userId, title: 'Mine', body: 'Some body text' },
    });

    const res = await request(app)
      .get(`/api/v1/notifications/${notification.id}`)
      .set(authHeader(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Mine');
    expect(res.body.body).toBe('Some body text');

    const forbidden = await request(app)
      .get(`/api/v1/notifications/${notification.id}`)
      .set(authHeader(other.accessToken));
    expect(forbidden.status).toBe(404);
  });
});
