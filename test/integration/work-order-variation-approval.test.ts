import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { waslSignServiceMock } = vi.hoisted(() => ({
  waslSignServiceMock: {
    isConfigured: vi.fn(() => true),
    provisionOrganisation: vi.fn(async () => '999'),
    createAgreementWorkflow: vi.fn(async () => ({
      agreementId: 'agr_1',
      status: 'in_progress',
      created: true,
    })),
    getWorkflowStatus: vi.fn(),
    cancelWorkflow: vi.fn(),
  },
}));

vi.mock('../../src/lib/waslSign.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/waslSign.js')>();
  return { ...actual, waslSignService: waslSignServiceMock };
});

import { createApp } from '../../src/app.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser, residentAccessToken } from '../helpers/auth.js';

const app = createApp();

function validProperty() {
  return {
    name: 'Marina Heights',
    code: `MARINA-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    addressLine1: '1 Marina Blvd',
    city: 'Dubai',
    country: 'UAE',
    propertyType: 'MIXED_USE',
  };
}

const threeTierPolicy = {
  currencyCode: 'AUD',
  enabled: true,
  rules: [
    { maxAmount: 1000, workflowMode: 'NONE' },
    { maxAmount: 5000, workflowMode: 'APPROVAL_ONLY' },
    { maxAmount: null, workflowMode: 'APPROVAL_THEN_SIGNATURE' },
  ],
};

/** A Work Order already authorised via RFQ award — estimatedCost is set to
 * the awarded quote's amount, exactly matching how a real "original
 * authorised amount" comes to exist. */
async function setupAwardedWorkOrder(accessToken: string, amount: number) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send(validProperty());
  const spaceRes = await request(app)
    .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
    .set(authHeader(accessToken))
    .send({ name: 'Rooftop Plant Room', code: 'ROOF', spaceType: 'COMMON_AREA' });
  const requestRes = await request(app)
    .post('/api/v1/maintenance-requests')
    .set(authHeader(accessToken))
    .send({
      title: 'AC not cooling',
      description: 'Rooftop condenser unit not cooling.',
      category: 'HVAC',
      priority: 'HIGH',
      propertyId: propertyRes.body.id,
      spaceId: spaceRes.body.id,
    });
  const contractorRes = await request(app)
    .post('/api/v1/contractors')
    .set(authHeader(accessToken))
    .send({
      name: 'Apex HVAC',
      email: `apex+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      tradeTypes: ['HVAC'],
    });
  const roundRes = await request(app)
    .post('/api/v1/quote-rounds')
    .set(authHeader(accessToken))
    .send({
      maintenanceRequestId: requestRes.body.id,
      title: 'Replace condenser',
      scopeDescription: 'Diagnose and repair rooftop condenser unit.',
      contractorIds: [contractorRes.body.id],
    });
  const inv = roundRes.body.invitations[0];
  await request(app)
    .patch(`/api/v1/quotes/${inv.quoteId}/submit`)
    .set(authHeader(accessToken))
    .send({ amount });
  const awardRes = await request(app)
    .post(`/api/v1/quote-rounds/${roundRes.body.id}/award`)
    .set(authHeader(accessToken))
    .send({ quoteId: inv.quoteId });

  return {
    workOrderId: awardRes.body.workOrder.id as string,
    contractorId: contractorRes.body.id as string,
    propertyId: propertyRes.body.id as string,
  };
}

async function configurePolicy(
  accessToken: string,
  policy: Record<string, unknown> = threeTierPolicy,
) {
  const res = await request(app)
    .put('/api/v1/organisations/me/approval-policy')
    .set(authHeader(accessToken))
    .send(policy);
  expect(res.status).toBe(200);
  return res.body;
}

async function createVariation(
  accessToken: string,
  workOrderId: string,
  amountDelta: number,
  description = 'Additional scope',
) {
  const res = await request(app)
    .post(`/api/v1/work-order-variations/work-order/${workOrderId}`)
    .set(authHeader(accessToken))
    .send({ description, amountDelta });
  expect(res.status).toBe(201);
  return res.body as { id: string; requiredWorkflowMode: string | null };
}

function signedCallbackFor(eventType: string, waslSignAgreementId: string, sourceEntityId: string) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    eventType,
    sourceSystem: 'wasl-property',
    sourceEntityId,
    waslSignAgreementId,
  };
}

async function sendCallback(payload: Record<string, unknown>) {
  const crypto = await import('node:crypto');
  const secret = process.env.WASLSIGN_WEBHOOK_SECRET ?? 'test-webhook-secret';
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return request(app)
    .post('/api/v1/integrations/waslsign/callback')
    .set('X-WaslSign-Signature', `sha256=${signature}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('work order variation Approval & Acceptance enforcement', () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    waslSignServiceMock.isConfigured.mockReturnValue(true);
    waslSignServiceMock.provisionOrganisation.mockResolvedValue('999');
    waslSignServiceMock.createAgreementWorkflow.mockResolvedValue({
      agreementId: 'agr_1',
      status: 'in_progress',
      created: true,
    });
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('NONE', () => {
    it('can be approved directly (no ceremony) and counts in the authorised total', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 500);
      expect(variation.requiredWorkflowMode).toBe('NONE');

      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe('APPROVED');
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10500);
    });
  });

  describe('APPROVAL_ONLY', () => {
    it('cannot become APPROVED before the approval step completes', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000);
      expect(variation.requiredWorkflowMode).toBe('APPROVAL_ONLY');

      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });

      const summaryBefore = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summaryBefore.body.authorisedTotal).toBe(10000);
      expect(summaryBefore.body.pendingVariationsTotal).toBe(3000);
    });

    it('approval completes the variation and it is then counted exactly once', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });

      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe('APPROVED');

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(13000);

      // Approving twice must never double-count.
      const second = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(second.status).toBe(409);
      const summaryAfter = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summaryAfter.body.authorisedTotal).toBe(13000);
    });

    it('rejection excludes the variation permanently', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });

      const reject = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/reject`)
        .set(authHeader(accessToken))
        .send({ reason: 'Not agreed' });
      expect(reject.status).toBe(200);
      expect(reject.body.status).toBe('REJECTED');

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);
    });
  });

  describe('SIGNATURE_ONLY', () => {
    it('cannot become APPROVED before signature, and starts a real WaslSign workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken, {
        currencyCode: 'AUD',
        enabled: true,
        rules: [{ maxAmount: null, workflowMode: 'SIGNATURE_ONLY' }],
      });
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 2000);

      const setMode = await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(setMode.status).toBe(200);
      expect(setMode.body.signatureStatus).toBe('PENDING');
      expect(setMode.body.waslSignAgreementId).toBe('agr_1');
      expect(waslSignServiceMock.createAgreementWorkflow).toHaveBeenCalledTimes(1);

      // Real context passed to the document/agreement — never fabricated.
      const call = waslSignServiceMock.createAgreementWorkflow.mock.calls[0][0];
      expect(call.title).toContain('Variation Acceptance');
      expect(call.sourceEntityId).toBe(variation.id);

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);

      const approveAttempt = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approveAttempt.status).toBe(409);
    });

    it('a successful callback approves the variation exactly once', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken, {
        currencyCode: 'AUD',
        enabled: true,
        rules: [{ maxAmount: null, workflowMode: 'SIGNATURE_ONLY' }],
      });
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 2000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const row = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      const payload = signedCallbackFor('SIGNED', row.waslSignAgreementId!, variation.id);
      const callbackRes = await sendCallback(payload);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body.handled).toBe(true);

      const afterCallback = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      expect(afterCallback.status).toBe('APPROVED');

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(12000);

      // Duplicate delivery of the exact same event must never double-count.
      const duplicate = await sendCallback(payload);
      expect(duplicate.body.handled).toBe(false);
      expect(duplicate.body.reason).toBe('duplicate');
      const summaryAfterDuplicate = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summaryAfterDuplicate.body.authorisedTotal).toBe(12000);
    });

    it('a declined signature does not approve the variation', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken, {
        currencyCode: 'AUD',
        enabled: true,
        rules: [{ maxAmount: null, workflowMode: 'SIGNATURE_ONLY' }],
      });
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 2000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const row = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      await sendCallback(signedCallbackFor('DECLINED', row.waslSignAgreementId!, variation.id));

      const afterCallback = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      expect(afterCallback.status).toBe('PENDING_APPROVAL');
      expect(afterCallback.signatureStatus).toBe('DECLINED');

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);
    });
  });

  describe('APPROVAL_THEN_SIGNATURE', () => {
    it('approval alone does not approve the variation; it starts the signature workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 7000);
      expect(variation.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');

      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });

      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe('PENDING_APPROVAL');
      expect(approve.body.approvalStatus).toBe('APPROVED');
      expect(approve.body.signatureStatus).toBe('PENDING');
      expect(waslSignServiceMock.createAgreementWorkflow).toHaveBeenCalledTimes(1);

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);
    });

    it('signature completion approves the variation', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 7000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));

      const row = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      await sendCallback(signedCallbackFor('SIGNED', row.waslSignAgreementId!, variation.id));

      const afterCallback = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      expect(afterCallback.status).toBe('APPROVED');

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(17000);
    });

    it('approval rejection prevents any signature workflow from starting', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 7000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });

      const reject = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/reject`)
        .set(authHeader(accessToken))
        .send({ reason: 'Too costly' });
      expect(reject.status).toBe(200);
      expect(reject.body.status).toBe('REJECTED');
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);
    });

    it('a rejected/failed signature never affects the authorised total', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 7000);
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));

      const row = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      await sendCallback(signedCallbackFor('EXPIRED', row.waslSignAgreementId!, variation.id));

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);
    });
  });

  describe('policy semantics', () => {
    it('the stored requirement survives a later organisation policy change', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 7000);
      expect(variation.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');

      await configurePolicy(accessToken, {
        currencyCode: 'AUD',
        enabled: true,
        rules: [{ maxAmount: null, workflowMode: 'NONE' }],
      });

      const refetched = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}`)
        .set(authHeader(accessToken));
      const same = refetched.body.items.find((v: { id: string }) => v.id === variation.id);
      expect(same.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');
    });

    it('a manager cannot downgrade the required workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000); // APPROVAL_ONLY band

      const attempt = await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'NONE' });
      expect(attempt.status).toBe(409);
    });

    it('a manager may strengthen beyond what the policy requires', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000); // APPROVAL_ONLY band

      const attempt = await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      expect(attempt.status).toBe(200);
      expect(attempt.body.approvalStatus).toBe('PENDING');
    });

    it('a null requirement (no policy configured) fails closed — approve is refused until a workflow is confirmed', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 3000);
      expect(variation.requiredWorkflowMode).toBeNull();

      const approveAttempt = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approveAttempt.status).toBe(409);

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10000);

      // Once explicitly confirmed (no floor since nothing was required),
      // approval proceeds normally.
      await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'NONE' });
      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
    });
  });

  describe('commercial summary correctness', () => {
    it('multiple approved variations sum correctly while pending/rejected/cancelled are excluded', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);

      const v1 = await createVariation(accessToken, workOrderId, 500); // NONE
      await request(app)
        .post(`/api/v1/work-order-variations/${v1.id}/approve`)
        .set(authHeader(accessToken));

      const v2 = await createVariation(accessToken, workOrderId, 3000); // APPROVAL_ONLY
      await request(app)
        .patch(`/api/v1/work-order-variations/${v2.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      await request(app)
        .post(`/api/v1/work-order-variations/${v2.id}/approve`)
        .set(authHeader(accessToken));

      const v3 = await createVariation(accessToken, workOrderId, 999); // still pending
      const v4 = await createVariation(accessToken, workOrderId, 200);
      await request(app)
        .post(`/api/v1/work-order-variations/${v4.id}/reject`)
        .set(authHeader(accessToken))
        .send({});
      const v5 = await createVariation(accessToken, workOrderId, 150);
      await request(app)
        .post(`/api/v1/work-order-variations/${v5.id}/cancel`)
        .set(authHeader(accessToken));
      void v3;

      const summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.approvedVariationsTotal).toBe(3500);
      expect(summary.body.authorisedTotal).toBe(13500);
      expect(summary.body.pendingVariationsTotal).toBe(999);
    });
  });

  describe('security', () => {
    it('a property-scoped manager cannot act on a variation outside their assigned property', async () => {
      const owner = await registerTestUser(app);
      await configurePolicy(owner.accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(owner.accessToken, 10000);
      const variation = await createVariation(owner.accessToken, workOrderId, 500);

      const otherPropertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(owner.accessToken))
        .send(validProperty());
      const addPersonRes = await request(app)
        .post(`/api/v1/properties/${otherPropertyRes.body.id}/memberships`)
        .set(authHeader(owner.accessToken))
        .send({ email: 'pm@example.com', firstName: 'P', lastName: 'M', role: 'PROPERTY_MANAGER' });
      const managerToken = residentAccessToken(
        addPersonRes.body.contact.userId ?? addPersonRes.body.contactId,
        owner.organisationId,
        addPersonRes.body.contactId,
      );

      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(managerToken));
      expect(approve.status).toBe(403);

      const setMode = await request(app)
        .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
        .set(authHeader(managerToken))
        .send({ workflowMode: 'NONE' });
      expect(setMode.status).toBe(403);
    });

    it('a different organisation cannot see or act on this variation', async () => {
      const orgA = await registerTestUser(app);
      await configurePolicy(orgA.accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(orgA.accessToken, 10000);
      const variation = await createVariation(orgA.accessToken, workOrderId, 500);

      const orgB = await registerTestUser(app);
      const approve = await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(orgB.accessToken));
      expect(approve.status).toBe(404);
    });

    it('an unauthenticated request cannot approve/reject/confirm a workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 500);

      expect(
        (await request(app).post(`/api/v1/work-order-variations/${variation.id}/approve`)).status,
      ).toBe(401);
      expect(
        (
          await request(app)
            .patch(`/api/v1/work-order-variations/${variation.id}/workflow-mode`)
            .send({ workflowMode: 'NONE' })
        ).status,
      ).toBe(401);
    });
  });

  describe('webhook safety', () => {
    it('routes correctly and rejects a callback for an unknown resource', async () => {
      const res = await sendCallback(signedCallbackFor('SIGNED', 'agr_x', 'does-not-exist'));
      expect(res.status).toBe(200);
      expect(res.body.handled).toBe(false);
      expect(res.body.reason).toBe('unknown_resource');
    });

    it('a callback for an already-terminal variation cannot incorrectly transition it', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);
      const variation = await createVariation(accessToken, workOrderId, 500);
      await request(app)
        .post(`/api/v1/work-order-variations/${variation.id}/approve`)
        .set(authHeader(accessToken));

      // No waslSignAgreementId was ever set for a NONE variation — simulate
      // a stray/late callback referencing this now-terminal row anyway.
      const res = await sendCallback(signedCallbackFor('SIGNED', 'agr_stray', variation.id));
      expect(res.body.handled).toBe(false);
      expect(res.body.reason).toBe('agreement_mismatch');

      const row = await testPrisma.workOrderVariation.findUniqueOrThrow({
        where: { id: variation.id },
      });
      expect(row.status).toBe('APPROVED');
    });
  });

  describe('acceptance scenario', () => {
    it('matches the full worked example end-to-end, including a replayed webhook', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId } = await setupAwardedWorkOrder(accessToken, 10000);

      // Variation A: AUD 500 -> NONE -> approved -> 10,500
      const a = await createVariation(accessToken, workOrderId, 500);
      expect(a.requiredWorkflowMode).toBe('NONE');
      await request(app)
        .post(`/api/v1/work-order-variations/${a.id}/approve`)
        .set(authHeader(accessToken));
      let summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10500);

      // Variation B: AUD 3,000 -> APPROVAL_ONLY -> before approval total
      // remains 10,500 -> approval completes -> 13,500
      const b = await createVariation(accessToken, workOrderId, 3000);
      expect(b.requiredWorkflowMode).toBe('APPROVAL_ONLY');
      await request(app)
        .patch(`/api/v1/work-order-variations/${b.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(10500);
      await request(app)
        .post(`/api/v1/work-order-variations/${b.id}/approve`)
        .set(authHeader(accessToken));
      summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(13500);

      // Variation C: AUD 7,000 -> APPROVAL_THEN_SIGNATURE -> approval
      // completes -> total remains 13,500 -> signature completes -> 20,500
      const c = await createVariation(accessToken, workOrderId, 7000);
      expect(c.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');
      await request(app)
        .patch(`/api/v1/work-order-variations/${c.id}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      await request(app)
        .post(`/api/v1/work-order-variations/${c.id}/approve`)
        .set(authHeader(accessToken));
      summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(13500);

      const cRow = await testPrisma.workOrderVariation.findUniqueOrThrow({ where: { id: c.id } });
      const completionPayload = signedCallbackFor('SIGNED', cRow.waslSignAgreementId!, c.id);
      await sendCallback(completionPayload);
      summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(20500);

      // Replay the exact same completion callback — total must remain
      // AUD 20,500, never double-counted.
      await sendCallback(completionPayload);
      summary = await request(app)
        .get(`/api/v1/work-order-variations/work-order/${workOrderId}/commercial-summary`)
        .set(authHeader(accessToken));
      expect(summary.body.authorisedTotal).toBe(20500);
    });
  });
});
