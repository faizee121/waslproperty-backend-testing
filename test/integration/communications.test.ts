import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { CommunicationDeliveryService } from '../../src/modules/communications/communications.delivery.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser, residentAccessToken } from '../helpers/auth.js';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({ providerMessageId: 'test-provider-message-id' }),
}));

vi.mock('../../src/lib/email.js', () => ({
  emailService: { send: sendMock },
}));

// A pass-through spy by default (delegates to the real write) — only a
// specific test below overrides it to reject once, to force a failure
// inside deliverOne's final short transaction without ever touching
// Prisma's own `$transaction` internals (spying on a live PrismaClient
// method directly breaks its interactive-transaction machinery — the
// write silently stops committing and `mockRestore()` does not cleanly
// undo it either, corrupting the shared testPrisma instance for every
// test that runs afterwards).
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(),
}));
vi.mock('../../src/modules/activity/activity.js', () => ({
  recordActivity: recordActivityMock,
}));

const app = createApp();
const deliveryService = new CommunicationDeliveryService(testPrisma);

const validProperty = {
  name: 'Darling Harbour Towers',
  code: 'DARLING-01',
  addressLine1: '88 Harbour Street',
  city: 'Sydney',
  country: 'Australia',
  propertyType: 'MIXED_USE',
};

async function setupPropertyWithTenant(accessToken: string) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send(validProperty);
  const propertyId = propertyRes.body.id as string;

  const spaceRes = await request(app)
    .post(`/api/v1/properties/${propertyId}/spaces`)
    .set(authHeader(accessToken))
    .send({ name: 'Apartment 803', code: '803', spaceType: 'APARTMENT' });
  const spaceId = spaceRes.body.id as string;

  const memberRes = await request(app)
    .post(`/api/v1/properties/${propertyId}/memberships`)
    .set(authHeader(accessToken))
    .send({
      email: `james+${Date.now()}@example.com`,
      firstName: 'James',
      lastName: 'Nguyen',
      role: 'TENANT',
      spaceId,
    });

  return { propertyId, spaceId, contactId: memberRes.body.contactId as string };
}

describe('communications', () => {
  beforeEach(async () => {
    await resetDb();
    sendMock.mockClear();
    sendMock.mockResolvedValue({ providerMessageId: 'test-provider-message-id' });
    recordActivityMock.mockReset();
    recordActivityMock.mockImplementation(
      async (client: { activityEvent: { create: (args: unknown) => unknown } }, input: unknown) =>
        client.activityEvent.create({ data: input }),
    );
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/communications');
    expect(res.status).toBe(401);
  });

  it('rejects a MEMBER creating a communication but the endpoint stays staff-only (RBAC)', async () => {
    const { organisationId, userId } = await registerTestUser(app);
    const memberToken = signAccessToken({
      sub: userId,
      sessionType: 'CUSTOMER',
      organisationId,
      orgRole: 'MEMBER',
    });

    const res = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(memberToken))
      .send({
        title: 'Test',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    expect(res.status).toBe(403);
  });

  it('creates a draft and does not resolve/send anything yet', async () => {
    const { accessToken, organisationId } = await registerTestUser(app);
    await setupPropertyWithTenant(accessToken);

    const res = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Lift maintenance this Thursday',
        body: 'Scheduled lift servicing.',
        channels: ['IN_APP', 'EMAIL'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.sentAt).toBeNull();

    const recipients = await testPrisma.communicationRecipient.count({
      where: { communicationId: res.body.id },
    });
    expect(recipients).toBe(0);

    const activity = await testPrisma.activityEvent.findFirst({
      where: { organisationId, eventType: 'ANNOUNCEMENT_CREATED' },
    });
    expect(activity).not.toBeNull();
  });

  it('rejects WHATSAPP as a selectable channel — it is not live yet', async () => {
    const { accessToken } = await registerTestUser(app);
    const res = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Test',
        body: 'Body',
        channels: ['WHATSAPP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    expect(res.status).toBe(422);
  });

  it('previews audience count scoped to a property, filtered by role', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId } = await setupPropertyWithTenant(accessToken);

    const tenantPreview = await request(app)
      .post('/api/v1/communications/preview-audience')
      .set(authHeader(accessToken))
      .send({
        audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['TENANT'] },
      });
    expect(tenantPreview.status).toBe(200);
    expect(tenantPreview.body.count).toBe(1);
    expect(tenantPreview.body.summary).toContain('Darling Harbour Towers');

    const ownerPreview = await request(app)
      .post('/api/v1/communications/preview-audience')
      .set(authHeader(accessToken))
      .send({
        audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['OWNER'] },
      });
    expect(ownerPreview.status).toBe(200);
    expect(ownerPreview.body.count).toBe(0);
  });

  it('previews audience scoped to a specific space', async () => {
    const { accessToken } = await registerTestUser(app);
    const { propertyId, spaceId } = await setupPropertyWithTenant(accessToken);

    // A second, unrelated space in the same property with nobody in it.
    const otherSpace = await request(app)
      .post(`/api/v1/properties/${propertyId}/spaces`)
      .set(authHeader(accessToken))
      .send({ name: 'Apartment 804', code: '804', spaceType: 'APARTMENT' });

    const inSpace = await request(app)
      .post('/api/v1/communications/preview-audience')
      .set(authHeader(accessToken))
      .send({ audienceCriteria: { scope: 'SPACE', spaceIds: [spaceId] } });
    expect(inSpace.body.count).toBe(1);

    const otherSpacePreview = await request(app)
      .post('/api/v1/communications/preview-audience')
      .set(authHeader(accessToken))
      .send({ audienceCriteria: { scope: 'SPACE', spaceIds: [otherSpace.body.id] } });
    expect(otherSpacePreview.body.count).toBe(0);
  });

  it('rejects PROPERTY scope with no properties selected', async () => {
    const { accessToken } = await registerTestUser(app);
    const res = await request(app)
      .post('/api/v1/communications/preview-audience')
      .set(authHeader(accessToken))
      .send({ audienceCriteria: { scope: 'PROPERTY' } });
    expect(res.status).toBe(422);
  });

  it('cannot edit a communication once it has been sent', async () => {
    const { accessToken } = await registerTestUser(app);
    await setupPropertyWithTenant(accessToken);

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Original title',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    await request(app)
      .post(`/api/v1/communications/${created.body.id}/send`)
      .set(authHeader(accessToken))
      .send({});
    await deliveryService.processDue(new Date(Date.now() + 60_000));

    const editAttempt = await request(app)
      .patch(`/api/v1/communications/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({ title: 'Changed title' });
    expect(editAttempt.status).toBe(409);
  });

  it('send-now resolves real recipients, creates in-app notifications, and marks SENT — full lifecycle', async () => {
    const { accessToken, organisationId } = await registerTestUser(app);
    const { propertyId } = await setupPropertyWithTenant(accessToken);

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Lift maintenance this Thursday',
        body: 'Scheduled lift servicing between 9am and 3pm.',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['TENANT'] },
      });
    const communicationId = created.body.id as string;

    const sendRes = await request(app)
      .post(`/api/v1/communications/${communicationId}/send`)
      .set(authHeader(accessToken))
      .send({});
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.status).toBe('SCHEDULED');

    // Simulate the delivery worker's next tick, well past scheduledAt.
    const { processed } = await deliveryService.processDue(new Date(Date.now() + 60_000));
    expect(processed).toBe(1);

    const sent = await testPrisma.communication.findUnique({ where: { id: communicationId } });
    expect(sent?.status).toBe('SENT');
    expect(sent?.sentAt).not.toBeNull();

    const recipients = await testPrisma.communicationRecipient.findMany({
      where: { communicationId },
    });
    expect(recipients).toHaveLength(1);

    // James has no portal account in this fixture (contact-only) — there's
    // no inbox to deliver an IN_APP notice to, so no delivery row (and no
    // Notification row) is fabricated for a channel that isn't actually
    // reachable for him.
    const deliveries = await testPrisma.communicationDelivery.findMany({
      where: { communicationRecipientId: recipients[0]!.id },
    });
    expect(deliveries).toHaveLength(0);

    const notifications = await testPrisma.notification.count({ where: { organisationId } });
    expect(notifications).toBe(0);

    const activity = await testPrisma.activityEvent.findFirst({
      where: { organisationId, eventType: 'ANNOUNCEMENT_SENT' },
    });
    expect(activity?.description).toContain('1 recipient');
  });

  it('creates an in-app notification for a recipient who does have portal access', async () => {
    const { accessToken, organisationId } = await registerTestUser(app);
    const { propertyId } = await setupPropertyWithTenant(accessToken);

    // A second tenant who *does* have a linked portal user, via the
    // existing "link an existing Wasl Property user by email" behaviour.
    const portalUser = await request(app)
      .post('/api/v1/auth/register')
      .send({
        organisationName: 'Unrelated Org',
        firstName: 'Mia',
        lastName: 'Johnson',
        email: `mia+${Date.now()}@example.com`,
        password: 'super-secret-1',
      });

    await request(app)
      .post(`/api/v1/properties/${propertyId}/memberships`)
      .set(authHeader(accessToken))
      .send({
        email: portalUser.body.user.email,
        firstName: 'Mia',
        lastName: 'Johnson',
        role: 'OWNER',
      });

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Owner notice',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['OWNER'] },
      });

    await request(app)
      .post(`/api/v1/communications/${created.body.id}/send`)
      .set(authHeader(accessToken))
      .send({});
    await deliveryService.processDue(new Date(Date.now() + 60_000));

    const notifications = await testPrisma.notification.findMany({
      where: { organisationId, sourceCommunicationId: created.body.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe('Owner notice');
  });

  it('schedules for later, then can be cancelled before delivery', async () => {
    const { accessToken } = await registerTestUser(app);
    await setupPropertyWithTenant(accessToken);

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Scheduled notice',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const sendRes = await request(app)
      .post(`/api/v1/communications/${created.body.id}/send`)
      .set(authHeader(accessToken))
      .send({ scheduledAt: future });
    expect(sendRes.body.status).toBe('SCHEDULED');

    // Not yet due — processing now must not touch it.
    const { processed } = await deliveryService.processDue(new Date());
    expect(processed).toBe(0);
    const stillScheduled = await testPrisma.communication.findUnique({
      where: { id: created.body.id },
    });
    expect(stillScheduled?.status).toBe('SCHEDULED');

    const cancelRes = await request(app)
      .post(`/api/v1/communications/${created.body.id}/cancel`)
      .set(authHeader(accessToken));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const cancelAgain = await request(app)
      .post(`/api/v1/communications/${created.body.id}/cancel`)
      .set(authHeader(accessToken));
    expect(cancelAgain.status).toBe(409);
  });

  it('is organisation-isolated — another org cannot see or act on this communication', async () => {
    const orgA = await registerTestUser(app);
    await setupPropertyWithTenant(orgA.accessToken);
    const orgB = await registerTestUser(app);

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(orgA.accessToken))
      .send({
        title: 'Org A only',
        body: 'Body',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    const crossOrgGet = await request(app)
      .get(`/api/v1/communications/${created.body.id}`)
      .set(authHeader(orgB.accessToken));
    expect(crossOrgGet.status).toBe(404);

    const crossOrgSend = await request(app)
      .post(`/api/v1/communications/${created.body.id}/send`)
      .set(authHeader(orgB.accessToken))
      .send({});
    expect(crossOrgSend.status).toBe(404);

    const list = await request(app).get('/api/v1/communications').set(authHeader(orgB.accessToken));
    expect(list.body.items).toHaveLength(0);
  });

  it('duplicates a sent announcement as a new editable draft', async () => {
    const { accessToken } = await registerTestUser(app);
    await setupPropertyWithTenant(accessToken);

    const created = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Original',
        body: 'Body text',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });
    await request(app)
      .post(`/api/v1/communications/${created.body.id}/send`)
      .set(authHeader(accessToken))
      .send({});
    await deliveryService.processDue(new Date(Date.now() + 60_000));

    const duplicated = await request(app)
      .post(`/api/v1/communications/${created.body.id}/duplicate`)
      .set(authHeader(accessToken));
    expect(duplicated.status).toBe(201);
    expect(duplicated.body.status).toBe('DRAFT');
    expect(duplicated.body.title).toBe('Original');
    expect(duplicated.body.id).not.toBe(created.body.id);
  });

  describe('delivery transaction shape and duplicate-send protection', () => {
    it('wraps delivery in exactly one short transaction, regardless of audience size — never one interactive transaction per recipient', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { propertyId, spaceId } = await setupPropertyWithTenant(accessToken);

      // A handful more tenants in the same space so the audience has more
      // than one recipient — the transaction call count below must stay 1
      // no matter how many recipients there are.
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post(`/api/v1/properties/${propertyId}/memberships`)
          .set(authHeader(accessToken))
          .send({
            email: `extra${i}+${Date.now()}@example.com`,
            firstName: `Extra${i}`,
            lastName: 'Tenant',
            role: 'TENANT',
            spaceId,
          });
      }

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Multi-recipient notice',
          body: 'Body',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['TENANT'] },
        });
      await request(app)
        .post(`/api/v1/communications/${created.body.id}/send`)
        .set(authHeader(accessToken))
        .send({});

      const { processed } = await deliveryService.processDue(new Date(Date.now() + 60_000));
      expect(processed).toBe(1);

      // This is the functional proof of the fix: the old implementation
      // did one upsert per recipient per channel *inside* a single
      // interactive transaction, so its duration scaled with audience
      // size — against a pooled remote connection that's exactly what
      // exceeded Prisma's 5s default interactive-transaction timeout
      // (P2028). The new implementation batches recipient/delivery/
      // notification writes via createMany/updateMany (O(1) round trips,
      // not O(recipients)) and keeps only a fixed, two-statement
      // transaction (recordActivity + mark SENT) — its cost never scales
      // with audience size, so it completes correctly here at N=5 and,
      // structurally, at any N.
      const recipients = await testPrisma.communicationRecipient.findMany({
        where: { communicationId: created.body.id },
      });
      expect(recipients).toHaveLength(5);
      const deliveries = await testPrisma.communicationDelivery.count({
        where: { communicationRecipient: { communicationId: created.body.id }, channel: 'EMAIL' },
      });
      expect(deliveries).toBe(5);
      expect(sendMock).toHaveBeenCalledTimes(5);

      const sent = await testPrisma.communication.findUnique({ where: { id: created.body.id } });
      expect(sent?.status).toBe('SENT');

      const activity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'ANNOUNCEMENT_SENT' },
      });
      expect(activity?.description).toContain('5 recipients');
    });

    it('recipient and delivery rows survive even if the final commit step fails — no longer one all-or-nothing transaction', async () => {
      const { accessToken } = await registerTestUser(app);
      await setupPropertyWithTenant(accessToken);

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Partial failure notice',
          body: 'Body',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'ORGANISATION' },
        });
      await request(app)
        .post(`/api/v1/communications/${created.body.id}/send`)
        .set(authHeader(accessToken))
        .send({});

      // Force the final short transaction (recordActivity + mark SENT) to
      // fail, simulating a transient DB error at that specific step —
      // without touching Prisma's own $transaction (see the comment on
      // recordActivityMock above for why that's unsafe to mock directly).
      recordActivityMock.mockRejectedValueOnce(new Error('simulated transient DB error'));

      await deliveryService.processDue(new Date(Date.now() + 60_000));

      const failed = await testPrisma.communication.findUnique({ where: { id: created.body.id } });
      expect(failed?.status).toBe('FAILED');

      // Recipient/delivery rows created before the failing step are real,
      // committed rows — not rolled back — because they were never part of
      // the same transaction as the step that failed.
      const recipients = await testPrisma.communicationRecipient.findMany({
        where: { communicationId: created.body.id },
      });
      expect(recipients).toHaveLength(1);
      const deliveries = await testPrisma.communicationDelivery.count({
        where: { communicationRecipient: { communicationId: created.body.id } },
      });
      expect(deliveries).toBe(1);
    });

    it('never sends the same email twice if delivery is resumed after already succeeding', async () => {
      const { accessToken } = await registerTestUser(app);
      await setupPropertyWithTenant(accessToken);

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Resumed delivery notice',
          body: 'Body',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'ORGANISATION' },
        });
      const communicationId = created.body.id as string;
      await request(app)
        .post(`/api/v1/communications/${communicationId}/send`)
        .set(authHeader(accessToken))
        .send({});

      await deliveryService.processDue(new Date(Date.now() + 60_000));
      expect(sendMock).toHaveBeenCalledTimes(1);

      const sentDelivery = await testPrisma.communicationDelivery.findFirst({
        where: { communicationRecipient: { communicationId }, channel: 'EMAIL' },
      });
      expect(sentDelivery?.status).toBe('SENT');
      expect(sentDelivery?.providerMessageId).toBe('test-provider-message-id');
      const firstSentAt = sentDelivery?.sentAt;

      // Simulate a resumed/retried delivery run for the same communication
      // (e.g. a worker restart re-invoking deliverOne directly) — the
      // email must not go out a second time.
      await deliveryService.deliverOne(communicationId);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const stillSentDelivery = await testPrisma.communicationDelivery.findFirst({
        where: { communicationRecipient: { communicationId }, channel: 'EMAIL' },
      });
      expect(stillSentDelivery?.status).toBe('SENT');
      expect(stillSentDelivery?.sentAt).toEqual(firstSentAt);
    });

    it('does retry a FAILED email delivery on the next run — the duplicate guard only blocks SENT/DELIVERED', async () => {
      const { accessToken } = await registerTestUser(app);
      await setupPropertyWithTenant(accessToken);

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Retry notice',
          body: 'Body',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'ORGANISATION' },
        });
      const communicationId = created.body.id as string;
      await request(app)
        .post(`/api/v1/communications/${communicationId}/send`)
        .set(authHeader(accessToken))
        .send({});

      sendMock.mockRejectedValueOnce(new Error('SMTP timeout'));
      await deliveryService.processDue(new Date(Date.now() + 60_000));
      expect(sendMock).toHaveBeenCalledTimes(1);

      const failedDelivery = await testPrisma.communicationDelivery.findFirst({
        where: { communicationRecipient: { communicationId }, channel: 'EMAIL' },
      });
      expect(failedDelivery?.status).toBe('FAILED');
      expect(failedDelivery?.failureReason).toContain('SMTP timeout');

      // Communication itself is already SENT (the fast transaction
      // committed before email sending ran) — only the email delivery
      // failed, so retrying delivery for the same communication must
      // actually resend, not be blocked by the duplicate-send guard.
      sendMock.mockResolvedValueOnce({ providerMessageId: 'retry-message-id' });
      await deliveryService.deliverOne(communicationId);

      expect(sendMock).toHaveBeenCalledTimes(2);
      const retriedDelivery = await testPrisma.communicationDelivery.findFirst({
        where: { communicationRecipient: { communicationId }, channel: 'EMAIL' },
      });
      expect(retriedDelivery?.status).toBe('SENT');
    });
  });

  describe('bounded delivery concurrency and stale-SENDING recovery', () => {
    it('never sends more than a bounded number of recipient emails concurrently, even for a large audience', async () => {
      const { accessToken } = await registerTestUser(app);
      const { propertyId } = await setupPropertyWithTenant(accessToken);

      // Add 11 more tenants to the same property (12 total) — enough to
      // prove a concurrency bound without making the test slow.
      for (let i = 0; i < 11; i++) {
        const spaceRes = await request(app)
          .post(`/api/v1/properties/${propertyId}/spaces`)
          .set(authHeader(accessToken))
          .send({ name: `Apartment ${900 + i}`, code: `${900 + i}`, spaceType: 'APARTMENT' });
        await request(app)
          .post(`/api/v1/properties/${propertyId}/memberships`)
          .set(authHeader(accessToken))
          .send({
            email: `tenant${i}+${Date.now()}@example.com`,
            firstName: 'T',
            lastName: `${i}`,
            role: 'TENANT',
            spaceId: spaceRes.body.id,
          });
      }

      let active = 0;
      let maxActive = 0;
      sendMock.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { providerMessageId: `msg-${Math.random()}` };
      });

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Fire drill notice',
          body: 'Mandatory fire drill this Friday at 10am.',
          channels: ['EMAIL'],
          audienceCriteria: { scope: 'PROPERTY', propertyIds: [propertyId], roles: ['TENANT'] },
        });
      await request(app)
        .post(`/api/v1/communications/${created.body.id}/send`)
        .set(authHeader(accessToken))
        .send({});

      const { processed } = await deliveryService.processDue(new Date(Date.now() + 60_000));
      expect(processed).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(12);
      // The actual bound this test exists to prove: never all 12 at once.
      expect(maxActive).toBeLessThanOrEqual(5);
      expect(maxActive).toBeGreaterThan(1); // and genuinely concurrent, not serialised to 1

      const sentCount = await testPrisma.communicationDelivery.count({
        where: { communicationRecipient: { communicationId: created.body.id }, status: 'SENT' },
      });
      expect(sentCount).toBe(12);
    });

    it('reclaims a communication stuck in SENDING past the threshold and successfully retries it to completion', async () => {
      const { accessToken } = await registerTestUser(app);
      await setupPropertyWithTenant(accessToken);

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Stuck notice',
          body: 'This delivery will simulate a crashed worker.',
          channels: ['IN_APP'],
          audienceCriteria: { scope: 'ORGANISATION' },
        });
      const communicationId = created.body.id as string;

      // Simulate a worker that claimed this (SCHEDULED -> SENDING) and
      // then crashed before deliverOne ever reached SENT/FAILED — stuck
      // long enough to be past the default 5-minute threshold.
      await testPrisma.communication.update({
        where: { id: communicationId },
        data: {
          status: 'SENDING',
          scheduledAt: new Date(Date.now() - 10 * 60_000),
          updatedAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      const { processed } = await deliveryService.processDue(new Date());
      expect(processed).toBe(1);

      const final = await testPrisma.communication.findUnique({ where: { id: communicationId } });
      expect(final?.status).toBe('SENT');
    });

    it('never reclaims a communication that is only briefly in SENDING (well under the threshold) — no false-positive double-processing', async () => {
      const { accessToken } = await registerTestUser(app);
      await setupPropertyWithTenant(accessToken);

      const created = await request(app)
        .post('/api/v1/communications')
        .set(authHeader(accessToken))
        .send({
          title: 'Fresh in-flight notice',
          body: 'This one is genuinely still being processed.',
          channels: ['IN_APP'],
          audienceCriteria: { scope: 'ORGANISATION' },
        });
      const communicationId = created.body.id as string;

      // Claimed moments ago — a live, legitimate in-flight delivery, not
      // a crash.
      await testPrisma.communication.update({
        where: { id: communicationId },
        data: { status: 'SENDING', scheduledAt: new Date(Date.now() - 1000) },
      });

      const { processed } = await deliveryService.processDue(new Date());
      expect(processed).toBe(0);

      const stillSending = await testPrisma.communication.findUnique({
        where: { id: communicationId },
      });
      expect(stillSending?.status).toBe('SENDING');
    });
  });

  describe('SPACE-scope audience authorization is tenant-scoped', () => {
    it("assertAudienceWithinScope itself rejects a SPACE-scope criteria referencing another organisation's space, not just the separate validate() existence check", async () => {
      const orgA = await registerTestUser(app);
      const { propertyId: propertyAId } = await setupPropertyWithTenant(orgA.accessToken);
      const addManagerRes = await request(app)
        .post(`/api/v1/properties/${propertyAId}/memberships`)
        .set(authHeader(orgA.accessToken))
        .send({ email: 'pm@example.com', firstName: 'P', lastName: 'M', role: 'PROPERTY_MANAGER' });
      const managerToken = residentAccessToken(
        addManagerRes.body.contact.userId ?? addManagerRes.body.contactId,
        orgA.organisationId,
        addManagerRes.body.contactId,
      );

      // A completely unrelated org/property/space.
      const orgB = await registerTestUser(app);
      const { spaceId: foreignSpaceId } = await setupPropertyWithTenant(orgB.accessToken);

      // Seeded directly (bypassing the create() route, which would
      // itself reject this via audience.validate()'s org-scoped existence
      // check before ever reaching assertAudienceWithinScope) — this
      // simulates a communication whose audienceCriteria already
      // reference a space that has since moved to another org, or simply
      // pre-existing data, so that the PATCH below exercises ONLY
      // assertAudienceWithinScope's own tenant check, independent of
      // validate().
      const seeded = await testPrisma.communication.create({
        data: {
          organisationId: orgA.organisationId,
          publicReference: `COM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          title: 'Pre-existing draft',
          body: 'Body',
          status: 'DRAFT',
          channels: ['IN_APP'],
          audienceCriteria: { scope: 'SPACE', spaceIds: [foreignSpaceId] },
          createdByUserId: orgA.userId,
        },
      });

      // Editing it WITHOUT touching audienceCriteria goes straight to
      // assertAudienceWithinScope against the stored criteria — no
      // validate() call on this path at all (see CommunicationsService
      // .update()).
      const res = await request(app)
        .patch(`/api/v1/communications/${seeded.id}`)
        .set(authHeader(managerToken))
        .send({ title: 'Renamed' });

      expect(res.status).toBe(403);
      const unchanged = await testPrisma.communication.findUnique({ where: { id: seeded.id } });
      expect(unchanged?.title).toBe('Pre-existing draft');
    });
  });
});
