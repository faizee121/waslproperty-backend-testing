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
import { authHeader, registerTestUser } from '../helpers/auth.js';

const app = createApp();

const validProperty = {
  name: 'Marina Heights',
  code: 'MARINA-HT',
  addressLine1: '1 Marina Blvd',
  city: 'Dubai',
  country: 'UAE',
  propertyType: 'MIXED_USE',
};
const validSpace = { name: 'Apartment 1204', code: '1204', spaceType: 'APARTMENT' };
const validRequestPayload = {
  title: 'Bedroom AC leaking',
  description: 'Leaking and not cooling.',
  category: 'HVAC',
  priority: 'HIGH',
};

async function setupWorkOrderWithContractor(accessToken: string, amount: number) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send(validProperty);
  const spaceRes = await request(app)
    .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
    .set(authHeader(accessToken))
    .send(validSpace);
  const requestRes = await request(app)
    .post('/api/v1/maintenance-requests')
    .set(authHeader(accessToken))
    .send({ ...validRequestPayload, propertyId: propertyRes.body.id, spaceId: spaceRes.body.id });
  const workOrderRes = await request(app)
    .post('/api/v1/work-orders')
    .set(authHeader(accessToken))
    .send({
      maintenanceRequestId: requestRes.body.id,
      title: 'Repair leaking AC unit',
      description: 'Replace the drain pan and re-seal the unit.',
      priority: 'HIGH',
    });
  const contractorRes = await request(app)
    .post('/api/v1/contractors')
    .set(authHeader(accessToken))
    .send({ name: 'Acme HVAC', email: 'ops@acmehvac.com', tradeTypes: ['HVAC'] });
  const quoteRes = await request(app).post('/api/v1/quotes').set(authHeader(accessToken)).send({
    workOrderId: workOrderRes.body.id,
    contractorId: contractorRes.body.id,
    amount,
    description: 'HVAC repair',
  });

  return { workOrderId: workOrderRes.body.id as string, quoteId: quoteRes.body.id as string };
}

describe('contractor quotes + workflow modes', () => {
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

  describe('organisation approval policy (replaces the old env-var threshold)', () => {
    async function configurePolicy(accessToken: string) {
      const res = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send({
          currencyCode: 'AUD',
          enabled: true,
          rules: [
            { maxAmount: 5000, workflowMode: 'NONE' },
            { maxAmount: null, workflowMode: 'APPROVAL_ONLY' },
          ],
        });
      expect(res.status).toBe(200);
      return res.body;
    }

    it('with no policy configured, a quote gets no suggested workflow and release stays blocked until a manager explicitly chooses one', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 500);

      const quote = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(quote.body.workflowMode).toBeNull();
      expect(quote.body.requiredWorkflowMode).toBeNull();

      // No silent bypass merely because policy is absent — release is still
      // blocked until a workflow is actually chosen.
      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(409);

      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'NONE' });
      expect(setMode.status).toBe(200);
    });

    it('resolves a low-value quote to the policy-configured NONE band and lets it be released without any workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 500);

      const quote = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(quote.body.workflowMode).toBe('NONE');
      expect(quote.body.requiredWorkflowMode).toBe('NONE');
      expect(quote.body.approvalPolicySnapshot.reason).toMatch(/AUD 5,000\.00/);

      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(200);
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();
    });

    it('a high-value quote resolves to the policy-required workflow as a suggestion only — release still blocks until the manager confirms it', async () => {
      // Regression: create() pre-fills workflowMode with the policy's
      // suggestion — that must never be mistaken for an actually-confirmed,
      // in-progress workflow.
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      const quote = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(quote.body.workflowMode).toBe('APPROVAL_ONLY');
      expect(quote.body.requiredWorkflowMode).toBe('APPROVAL_ONLY');
      expect(quote.body.approvalStatus).toBeNull();

      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(409);
    });

    it('a manager cannot weaken the policy-required workflow to NONE', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'NONE' });
      expect(setMode.status).toBe(409);
      expect(setMode.body.error.message).toMatch(/policy requires at least/i);
    });

    it('a manager may add more control than the policy requires', async () => {
      const { accessToken } = await registerTestUser(app);
      await configurePolicy(accessToken);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      // Required: APPROVAL_ONLY. Strengthening to APPROVAL_THEN_SIGNATURE
      // adds the signature gate on top rather than removing the approval
      // one, so it must be allowed.
      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      expect(setMode.status).toBe(200);
      expect(setMode.body.approvalStatus).toBe('PENDING');
    });
  });

  describe('APPROVAL_ONLY', () => {
    it('completes natively with no WaslSign call, and lets the work order proceed once approved', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      expect(setMode.status).toBe(200);
      expect(setMode.body.approvalStatus).toBe('PENDING');
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();

      // Cannot release before approval.
      const tooSoon = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(tooSoon.status).toBe(409);

      const approve = await request(app)
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe('APPROVED');
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();

      // Approval alone completes this workflow — the work order is released
      // automatically, without a separate manual "move to Ready" click.
      const workOrder = await request(app)
        .get(`/api/v1/work-orders/${workOrderId}`)
        .set(authHeader(accessToken));
      expect(workOrder.body.status).toBe('READY');

      const approvedActivity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'QUOTE_APPROVED' },
      });
      expect(approvedActivity).toBeTruthy();
    });

    it('rejection blocks the quote and the work order can never be released against it', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });

      const reject = await request(app)
        .post(`/api/v1/quotes/${quoteId}/reject`)
        .set(authHeader(accessToken))
        .send({ reason: 'Too expensive' });
      expect(reject.status).toBe(200);
      expect(reject.body.status).toBe('REJECTED');

      const ready = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(ready.status).toBe(200); // rejected quote is excluded from governance — nothing left to block on
    });

    it('cannot approve twice', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      await request(app).post(`/api/v1/quotes/${quoteId}/approve`).set(authHeader(accessToken));

      const second = await request(app)
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set(authHeader(accessToken));
      expect(second.status).toBe(409);
    });
  });

  describe('SIGNATURE_ONLY', () => {
    it('creates a WaslSign workflow immediately and stays pending until signed', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(setMode.status).toBe(200);
      expect(setMode.body.signatureStatus).toBe('PENDING');
      expect(setMode.body.waslSignAgreementId).toBe('agr_1');
      expect(waslSignServiceMock.createAgreementWorkflow).toHaveBeenCalledTimes(1);

      const pending = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(pending.status).toBe(409);

      const signingActivity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'QUOTE_SIGNING_STARTED' },
      });
      expect(signingActivity).toBeTruthy();
    });

    it('provisions the WaslSign organisation lazily, once, and reuses it on the next quote', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(waslSignServiceMock.provisionOrganisation).toHaveBeenCalledTimes(1);

      const org = await testPrisma.organisation.findUnique({ where: { id: organisationId } });
      expect(org?.waslSignOrganisationId).toBe('999');

      const { quoteId: secondQuoteId } = await setupWorkOrderWithContractor(accessToken, 8000);
      await request(app)
        .patch(`/api/v1/quotes/${secondQuoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(waslSignServiceMock.provisionOrganisation).toHaveBeenCalledTimes(1); // still just once
    });

    it('completing the signature via webhook releases the work order automatically', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      const payload = signedCallbackFor(quote.waslSignAgreementId!, quoteId);
      const callbackRes = await sendCallback(payload);
      expect(callbackRes.status).toBe(200);

      // The webhook itself already released it — DRAFT -> READY is not a
      // manager decision, just an acknowledgement that the gate opened.
      const workOrder = await request(app)
        .get(`/api/v1/work-orders/${workOrderId}`)
        .set(authHeader(accessToken));
      expect(workOrder.body.status).toBe('READY');

      const releaseActivity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'WORK_ORDER_STATUS_CHANGED', actorUserId: null },
      });
      expect(releaseActivity).toBeTruthy();
    });

    it('does not release on a declined signature', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      await sendCallback({
        eventId: 'evt-declined-1',
        eventType: 'DECLINED',
        sourceSystem: 'wasl-property',
        sourceEntityId: quoteId,
        waslSignAgreementId: quote.waslSignAgreementId!,
      });

      const ready = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(ready.status).toBe(409);
    });

    it('does not automatically treat an expired signature as rejected — it stays FAILED, distinct from REJECTED', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      await sendCallback({
        eventId: 'evt-expired-1',
        eventType: 'EXPIRED',
        sourceSystem: 'wasl-property',
        sourceEntityId: quoteId,
        waslSignAgreementId: quote.waslSignAgreementId!,
      });

      const updated = await testPrisma.contractorQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(updated.signatureStatus).toBe('EXPIRED');
      // Quote status itself is untouched — never silently turned into REJECTED.
      expect(updated.status).not.toBe('REJECTED');
    });
  });

  describe('APPROVAL_THEN_SIGNATURE', () => {
    it('starts approval first; signature never starts before approval passes', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 30_000);

      const setMode = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      expect(setMode.body.approvalStatus).toBe('PENDING');
      expect(setMode.body.signatureStatus).toBeNull();
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();
    });

    it('rejection prevents the signature stage from ever starting', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 30_000);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });

      await request(app)
        .post(`/api/v1/quotes/${quoteId}/reject`)
        .set(authHeader(accessToken))
        .send({});
      expect(waslSignServiceMock.createAgreementWorkflow).not.toHaveBeenCalled();

      const updated = await testPrisma.contractorQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(updated.signatureStatus).toBeNull();
    });

    it('approval enables and starts the signature stage automatically', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 30_000);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });

      const approve = await request(app)
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set(authHeader(accessToken));
      expect(approve.status).toBe(200);
      expect(approve.body.approvalStatus).toBe('APPROVED');
      expect(approve.body.signatureStatus).toBe('PENDING');
      expect(waslSignServiceMock.createAgreementWorkflow).toHaveBeenCalledTimes(1);

      // Approved but not yet signed — still can't release.
      const tooSoon = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(tooSoon.status).toBe(409);

      const approvedActivity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'QUOTE_APPROVED' },
      });
      const signingActivity = await testPrisma.activityEvent.findFirst({
        where: { organisationId, eventType: 'QUOTE_SIGNING_STARTED' },
      });
      expect(approvedActivity).toBeTruthy();
      expect(signingActivity).toBeTruthy();
    });

    it('a partial signature (one of two signers) remains pending, not complete', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 30_000);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      await request(app).post(`/api/v1/quotes/${quoteId}/approve`).set(authHeader(accessToken));

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      await sendCallback({
        eventId: 'evt-partial-1',
        eventType: 'PARTIALLY_SIGNED',
        sourceSystem: 'wasl-property',
        sourceEntityId: quoteId,
        waslSignAgreementId: quote.waslSignAgreementId!,
      });

      const ready = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(ready.status).toBe(409);
    });

    it('the final signature completes the workflow and releases the work order automatically', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 30_000);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_THEN_SIGNATURE' });
      await request(app).post(`/api/v1/quotes/${quoteId}/approve`).set(authHeader(accessToken));

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      await sendCallback(signedCallbackFor(quote.waslSignAgreementId!, quoteId));

      const workOrder = await request(app)
        .get(`/api/v1/work-orders/${workOrderId}`)
        .set(authHeader(accessToken));
      expect(workOrder.body.status).toBe('READY');
    });
  });

  describe('WaslSign integration failure modes', () => {
    it('fails closed when WaslSign is unavailable', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      waslSignServiceMock.createAgreementWorkflow.mockRejectedValueOnce(new Error('network down'));

      const res = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(res.status).toBe(500);

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      expect(quote.signatureStatus).toBeNull();
    });

    it('rejects starting a signature workflow when WaslSign is not configured', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      waslSignServiceMock.isConfigured.mockReturnValue(false);

      const res = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });
      expect(res.status).toBe(409);
    });
  });

  describe('webhook callback safety', () => {
    it('is idempotent — a duplicate eventId does not duplicate activity or change state twice', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      const payload = signedCallbackFor(quote.waslSignAgreementId!, quoteId);
      await sendCallback(payload);
      await sendCallback(payload); // exact duplicate, same eventId

      const activity = await testPrisma.activityEvent.findMany({
        where: { organisationId, eventType: 'QUOTE_SIGNED' },
      });
      expect(activity).toHaveLength(1);
    });

    it('ignores a callback whose waslSignAgreementId does not match the quote (cross-tampering guard)', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      await sendCallback(signedCallbackFor('agr_wrong', quoteId));

      const stillPending = await testPrisma.contractorQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(stillPending.signatureStatus).toBe('PENDING');

      const ready = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(ready.status).toBe(409);
    });

    it('ignores a callback for an unknown quote id', async () => {
      const res = await sendCallback(signedCallbackFor('agr_1', 'does-not-exist'));
      expect(res.status).toBe(200);
      expect(res.body.handled).toBe(false);
    });

    it('rejects a callback with an invalid signature', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'SIGNATURE_ONLY' });

      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      const res = await request(app)
        .post('/api/v1/integrations/waslsign/callback')
        .set('X-WaslSign-Signature', 'sha256=deadbeef')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(signedCallbackFor(quote.waslSignAgreementId!, quoteId)));
      expect(res.status).toBe(401);
    });
  });

  describe('currency', () => {
    it('a work order and a quote both inherit the organisation currency (AUD by default)', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 1000);

      const workOrder = await testPrisma.workOrder.findUniqueOrThrow({
        where: { id: workOrderId },
      });
      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      expect(workOrder.currencyCode).toBe('AUD');
      expect(quote.currencyCode).toBe('AUD');
    });

    it('inherits a non-default organisation currency', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      await testPrisma.organisation.update({
        where: { id: organisationId },
        data: { currencyCode: 'GBP' },
      });

      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 1000);
      const workOrder = await testPrisma.workOrder.findUniqueOrThrow({
        where: { id: workOrderId },
      });
      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      expect(workOrder.currencyCode).toBe('GBP');
      expect(quote.currencyCode).toBe('GBP');
    });

    it('respects an explicit per-quote currency override, independent of the organisation default', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send(validProperty);
      const requestRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({ ...validRequestPayload, propertyId: propertyRes.body.id });
      const workOrderRes = await request(app)
        .post('/api/v1/work-orders')
        .set(authHeader(accessToken))
        .send({
          maintenanceRequestId: requestRes.body.id,
          title: 'Repair',
          description: 'test',
          priority: 'LOW',
        });
      const contractorRes = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({
          name: 'Overseas Contractor',
          email: `overseas+${Date.now()}@example.com`,
          tradeTypes: ['HVAC'],
        });

      const quoteRes = await request(app).post('/api/v1/quotes').set(authHeader(accessToken)).send({
        workOrderId: workOrderRes.body.id,
        contractorId: contractorRes.body.id,
        amount: 500,
        currencyCode: 'usd',
        description: 'test',
      });
      expect(quoteRes.status).toBe(201);
      expect(quoteRes.body.currencyCode).toBe('USD');
    });

    it('rejects an unsupported currency code on quote creation', async () => {
      const { accessToken } = await registerTestUser(app);
      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send(validProperty);
      const requestRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({ ...validRequestPayload, propertyId: propertyRes.body.id });
      const workOrderRes = await request(app)
        .post('/api/v1/work-orders')
        .set(authHeader(accessToken))
        .send({
          maintenanceRequestId: requestRes.body.id,
          title: 'Repair',
          description: 'test',
          priority: 'LOW',
        });
      const contractorRes = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({
          name: 'Bad Currency Co',
          email: `badcurrency+${Date.now()}@example.com`,
          tradeTypes: ['HVAC'],
        });

      const res = await request(app).post('/api/v1/quotes').set(authHeader(accessToken)).send({
        workOrderId: workOrderRes.body.id,
        contractorId: contractorRes.body.id,
        amount: 500,
        currencyCode: 'NOTREAL',
        description: 'test',
      });
      expect(res.status).toBe(422);
    });

    it('changing the organisation currency after the fact never mutates an existing quote or work order', async () => {
      const { accessToken } = await registerTestUser(app);
      const { workOrderId, quoteId } = await setupWorkOrderWithContractor(accessToken, 1000);

      await request(app)
        .patch('/api/v1/organisations/me')
        .set(authHeader(accessToken))
        .send({ currencyCode: 'EUR' });

      const workOrder = await testPrisma.workOrder.findUniqueOrThrow({
        where: { id: workOrderId },
      });
      const quote = await testPrisma.contractorQuote.findUniqueOrThrow({ where: { id: quoteId } });
      expect(workOrder.currencyCode).toBe('AUD');
      expect(quote.currencyCode).toBe('AUD');

      // A quote created AFTER the change picks up the new default.
      const contractorRes = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({
          name: 'Post-Change Co',
          email: `postchange+${Date.now()}@example.com`,
          tradeTypes: ['HVAC'],
        });
      const newQuoteRes = await request(app)
        .post('/api/v1/quotes')
        .set(authHeader(accessToken))
        .send({
          workOrderId,
          contractorId: contractorRes.body.id,
          amount: 200,
          description: 'test',
        });
      expect(newQuoteRes.body.currencyCode).toBe('EUR');
    });
  });
});

function signedCallbackFor(waslSignAgreementId: string, quoteId: string) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    eventType: 'SIGNED',
    sourceSystem: 'wasl-property',
    sourceEntityId: quoteId,
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
