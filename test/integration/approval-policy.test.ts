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

async function setupWorkOrderWithContractor(accessToken: string, amount: number) {
  const propertyRes = await request(app)
    .post('/api/v1/properties')
    .set(authHeader(accessToken))
    .send(validProperty());
  const spaceRes = await request(app)
    .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
    .set(authHeader(accessToken))
    .send({ name: 'Apartment 1204', code: '1204', spaceType: 'APARTMENT' });
  const requestRes = await request(app)
    .post('/api/v1/maintenance-requests')
    .set(authHeader(accessToken))
    .send({
      title: 'Bedroom AC leaking',
      description: 'Leaking and not cooling.',
      category: 'HVAC',
      priority: 'HIGH',
      propertyId: propertyRes.body.id,
      spaceId: spaceRes.body.id,
    });
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
    .send({
      name: 'Acme HVAC',
      email: `ops+${Date.now()}-${Math.random().toString(36).slice(2)}@acmehvac.com`,
      tradeTypes: ['HVAC'],
    });
  const quoteRes = await request(app).post('/api/v1/quotes').set(authHeader(accessToken)).send({
    workOrderId: workOrderRes.body.id,
    contractorId: contractorRes.body.id,
    amount,
    description: 'HVAC repair',
  });

  return {
    propertyId: propertyRes.body.id as string,
    requestId: requestRes.body.id as string,
    workOrderId: workOrderRes.body.id as string,
    quoteId: quoteRes.body.id as string,
    contractorId: contractorRes.body.id as string,
  };
}

async function setupRfqRound(accessToken: string, contractorIds: string[]) {
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
  const roundRes = await request(app)
    .post('/api/v1/quote-rounds')
    .set(authHeader(accessToken))
    .send({
      maintenanceRequestId: requestRes.body.id,
      title: 'Replace condenser',
      scopeDescription: 'Diagnose and repair rooftop condenser unit.',
      contractorIds,
    });
  return roundRes.body as {
    id: string;
    invitations: Array<{ id: string; contractorId: string; quoteId: string }>;
  };
}

describe('organisation approval & acceptance policy', () => {
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

  describe('RBAC', () => {
    it('OWNER can configure the policy', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(3);
    });

    it('a property-scoped resident/manager token (no org role) cannot configure or view the policy', async () => {
      const { accessToken, organisationId } = await registerTestUser(app);
      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send(validProperty());
      const addPersonRes = await request(app)
        .post(`/api/v1/properties/${propertyRes.body.id}/memberships`)
        .set(authHeader(accessToken))
        .send({ email: 'pm@example.com', firstName: 'P', lastName: 'M', role: 'PROPERTY_MANAGER' });
      const managerToken = residentAccessToken(
        addPersonRes.body.contact.userId ?? addPersonRes.body.contactId,
        organisationId,
        addPersonRes.body.contactId,
      );

      const getRes = await request(app)
        .get('/api/v1/organisations/me/approval-policy')
        .set(authHeader(managerToken));
      expect(getRes.status).toBe(403);

      const putRes = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(managerToken))
        .send(threeTierPolicy);
      expect(putRes.status).toBe(403);
    });

    it('unauthenticated requests are rejected', async () => {
      const res = await request(app).get('/api/v1/organisations/me/approval-policy');
      expect(res.status).toBe(401);
    });
  });

  describe('organisation isolation', () => {
    it("org A cannot see or affect org B's policy", async () => {
      const orgA = await registerTestUser(app);
      const orgB = await registerTestUser(app);

      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(orgA.accessToken))
        .send(threeTierPolicy);

      const orgBPolicy = await request(app)
        .get('/api/v1/organisations/me/approval-policy')
        .set(authHeader(orgB.accessToken));
      expect(orgBPolicy.body).toBeNull();
    });
  });

  describe('validation', () => {
    it('rejects a policy whose highest band is not open-ended', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send({
          currencyCode: 'AUD',
          enabled: true,
          rules: [{ maxAmount: 1000, workflowMode: 'NONE' }],
        });
      expect(res.status).toBe(422);
    });

    it('rejects overlapping/non-increasing bands', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send({
          currencyCode: 'AUD',
          enabled: true,
          rules: [
            { maxAmount: 5000, workflowMode: 'NONE' },
            { maxAmount: 1000, workflowMode: 'APPROVAL_ONLY' },
            { maxAmount: null, workflowMode: 'APPROVAL_THEN_SIGNATURE' },
          ],
        });
      expect(res.status).toBe(422);
    });

    it('rejects a negative or zero amount', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send({
          currencyCode: 'AUD',
          enabled: true,
          rules: [
            { maxAmount: -100, workflowMode: 'NONE' },
            { maxAmount: null, workflowMode: 'APPROVAL_ONLY' },
          ],
        });
      expect(res.status).toBe(422);
    });
  });

  describe('resolution — amount boundaries', () => {
    it('999.99 resolves to NONE, 1000.00 resolves to NONE, 1000.01 resolves to APPROVAL_ONLY', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const a = await setupWorkOrderWithContractor(accessToken, 999.99);
      const b = await setupWorkOrderWithContractor(accessToken, 1000.0);
      const c = await setupWorkOrderWithContractor(accessToken, 1000.01);

      const quoteA = await request(app)
        .get(`/api/v1/quotes/${a.quoteId}`)
        .set(authHeader(accessToken));
      const quoteB = await request(app)
        .get(`/api/v1/quotes/${b.quoteId}`)
        .set(authHeader(accessToken));
      const quoteC = await request(app)
        .get(`/api/v1/quotes/${c.quoteId}`)
        .set(authHeader(accessToken));

      expect(quoteA.body.workflowMode).toBe('NONE');
      expect(quoteB.body.workflowMode).toBe('NONE');
      expect(quoteC.body.workflowMode).toBe('APPROVAL_ONLY');
    });

    it('5000.00 resolves to APPROVAL_ONLY, 5000.01 resolves to APPROVAL_THEN_SIGNATURE', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const a = await setupWorkOrderWithContractor(accessToken, 5000.0);
      const b = await setupWorkOrderWithContractor(accessToken, 5000.01);

      const quoteA = await request(app)
        .get(`/api/v1/quotes/${a.quoteId}`)
        .set(authHeader(accessToken));
      const quoteB = await request(app)
        .get(`/api/v1/quotes/${b.quoteId}`)
        .set(authHeader(accessToken));

      expect(quoteA.body.workflowMode).toBe('APPROVAL_ONLY');
      expect(quoteB.body.workflowMode).toBe('APPROVAL_THEN_SIGNATURE');
    });
  });

  describe('currency mismatch', () => {
    it('a quote in a different currency than the policy resolves to no floor, not a fabricated conversion', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy); // AUD

      const propertyRes = await request(app)
        .post('/api/v1/properties')
        .set(authHeader(accessToken))
        .send(validProperty());
      const spaceRes = await request(app)
        .post(`/api/v1/properties/${propertyRes.body.id}/spaces`)
        .set(authHeader(accessToken))
        .send({ name: 'Apartment 1204', code: '1204', spaceType: 'APARTMENT' });
      const requestRes = await request(app)
        .post('/api/v1/maintenance-requests')
        .set(authHeader(accessToken))
        .send({
          title: 'Leak',
          description: 'Leak',
          category: 'PLUMBING',
          priority: 'HIGH',
          propertyId: propertyRes.body.id,
          spaceId: spaceRes.body.id,
        });
      const workOrderRes = await request(app)
        .post('/api/v1/work-orders')
        .set(authHeader(accessToken))
        .send({
          maintenanceRequestId: requestRes.body.id,
          title: 'Fix leak',
          description: 'x',
          priority: 'HIGH',
        });
      const contractorRes = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({ name: 'Acme Plumbing', email: 'ops@acmeplumb.com', tradeTypes: ['PLUMBING'] });
      const quoteRes = await request(app).post('/api/v1/quotes').set(authHeader(accessToken)).send({
        workOrderId: workOrderRes.body.id,
        contractorId: contractorRes.body.id,
        amount: 9000,
        currencyCode: 'USD',
      });

      expect(quoteRes.body.workflowMode).toBeNull();
      expect(quoteRes.body.requiredWorkflowMode).toBeNull();
      expect(quoteRes.body.approvalPolicySnapshot.currencyMismatch).toBe(true);

      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderRes.body.id}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(409);
    });
  });

  describe('RFQ integration', () => {
    it('a submitted-but-unselected RFQ quote never resolves or starts a workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const c1Res = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({ name: 'Apex HVAC', email: 'a@apex.com', tradeTypes: ['HVAC'] });
      const c2Res = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({ name: 'Coastal Air', email: 'b@coastal.com', tradeTypes: ['HVAC'] });
      const round = await setupRfqRound(accessToken, [c1Res.body.id, c2Res.body.id]);
      const inv1 = round.invitations.find((i) => i.contractorId === c1Res.body.id)!;
      const inv2 = round.invitations.find((i) => i.contractorId === c2Res.body.id)!;

      await request(app)
        .patch(`/api/v1/quotes/${inv1.quoteId}/submit`)
        .set(authHeader(accessToken))
        .send({ amount: 7500 });
      await request(app)
        .patch(`/api/v1/quotes/${inv2.quoteId}/submit`)
        .set(authHeader(accessToken))
        .send({ amount: 6800 });

      const submittedQuote1 = await request(app)
        .get(`/api/v1/quotes/${inv1.quoteId}`)
        .set(authHeader(accessToken));
      const submittedQuote2 = await request(app)
        .get(`/api/v1/quotes/${inv2.quoteId}`)
        .set(authHeader(accessToken));

      // Receiving a quote is not approval — neither submission resolved or
      // pre-filled a workflow, even though both amounts are well above the
      // configured APPROVAL_THEN_SIGNATURE threshold.
      expect(submittedQuote1.body.workflowMode).toBeNull();
      expect(submittedQuote1.body.requiredWorkflowMode).toBeNull();
      expect(submittedQuote2.body.workflowMode).toBeNull();
      expect(submittedQuote2.body.requiredWorkflowMode).toBeNull();
    });

    it('the selected/awarded quote resolves the correct policy workflow at award time', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const c1Res = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({ name: 'Apex HVAC', email: 'a2@apex.com', tradeTypes: ['HVAC'] });
      const round = await setupRfqRound(accessToken, [c1Res.body.id]);
      const inv1 = round.invitations[0];

      await request(app)
        .patch(`/api/v1/quotes/${inv1.quoteId}/submit`)
        .set(authHeader(accessToken))
        .send({ amount: 7500 });

      const awardRes = await request(app)
        .post(`/api/v1/quote-rounds/${round.id}/award`)
        .set(authHeader(accessToken))
        .send({ quoteId: inv1.quoteId });
      expect(awardRes.status).toBe(200);

      const awardedQuote = await request(app)
        .get(`/api/v1/quotes/${inv1.quoteId}`)
        .set(authHeader(accessToken));
      expect(awardedQuote.body.workflowMode).toBe('APPROVAL_THEN_SIGNATURE');
      expect(awardedQuote.body.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');
      expect(awardedQuote.body.approvalPolicySnapshot.reason).toMatch(/AUD 5,000\.01/);
    });
  });

  describe('historical immutability', () => {
    it("changing the policy after a quote is awarded never mutates that quote's already-resolved workflow", async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const { quoteId, workOrderId } = await setupWorkOrderWithContractor(accessToken, 7500);
      const before = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(before.body.workflowMode).toBe('APPROVAL_THEN_SIGNATURE');

      // Organisation changes its mind entirely — everything now NONE.
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send({
          currencyCode: 'AUD',
          enabled: true,
          rules: [{ maxAmount: null, workflowMode: 'NONE' }],
        });

      const after = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(after.body.workflowMode).toBe('APPROVAL_THEN_SIGNATURE');
      expect(after.body.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');

      // And release is still correctly blocked by the historical
      // requirement, not silently waived by the new, weaker policy.
      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(409);
    });
  });

  describe('no-weakening enforcement', () => {
    it('a manager cannot downgrade a policy-required workflow', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);

      const attempt = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      expect(attempt.status).toBe(409);
    });

    it('a manager may strengthen beyond what the policy requires', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);
      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 500); // NONE band

      const confirm = await request(app)
        .patch(`/api/v1/quotes/${quoteId}/workflow-mode`)
        .set(authHeader(accessToken))
        .send({ workflowMode: 'APPROVAL_ONLY' });
      expect(confirm.status).toBe(200);
      expect(confirm.body.approvalStatus).toBe('PENDING');
    });
  });

  describe('no policy configured', () => {
    it('never silently bypasses approval — a manager must explicitly choose', async () => {
      const { accessToken } = await registerTestUser(app);
      const { quoteId, workOrderId } = await setupWorkOrderWithContractor(accessToken, 50000);

      const quote = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(quote.body.workflowMode).toBeNull();

      const toReady = await request(app)
        .patch(`/api/v1/work-orders/${workOrderId}/status`)
        .set(authHeader(accessToken))
        .send({ status: 'READY' });
      expect(toReady.status).toBe(409);
    });
  });

  describe('Direct Work vs RFQ use the same resolver', () => {
    it('a Direct Work quote and an RFQ-awarded quote at the same amount resolve identically', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const direct = await setupWorkOrderWithContractor(accessToken, 3000);
      const directQuote = await request(app)
        .get(`/api/v1/quotes/${direct.quoteId}`)
        .set(authHeader(accessToken));

      const c1Res = await request(app)
        .post('/api/v1/contractors')
        .set(authHeader(accessToken))
        .send({ name: 'Apex HVAC', email: 'a3@apex.com', tradeTypes: ['HVAC'] });
      const round = await setupRfqRound(accessToken, [c1Res.body.id]);
      const inv1 = round.invitations[0];
      await request(app)
        .patch(`/api/v1/quotes/${inv1.quoteId}/submit`)
        .set(authHeader(accessToken))
        .send({ amount: 3000 });
      await request(app)
        .post(`/api/v1/quote-rounds/${round.id}/award`)
        .set(authHeader(accessToken))
        .send({ quoteId: inv1.quoteId });
      const rfqQuote = await request(app)
        .get(`/api/v1/quotes/${inv1.quoteId}`)
        .set(authHeader(accessToken));

      expect(directQuote.body.workflowMode).toBe('APPROVAL_ONLY');
      expect(rfqQuote.body.workflowMode).toBe('APPROVAL_ONLY');
    });
  });

  describe('variations use the central resolver', () => {
    async function awardedWorkOrder(accessToken: string, amount: number) {
      const { workOrderId } = await setupWorkOrderWithContractor(accessToken, amount);
      return workOrderId;
    }

    it('a variation is resolved against the same policy, on its own amount', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);
      const workOrderId = await awardedWorkOrder(accessToken, 500);

      const variation = await request(app)
        .post(`/api/v1/work-order-variations/work-order/${workOrderId}`)
        .set(authHeader(accessToken))
        .send({ description: 'Extra ducting found', amountDelta: 6000 });

      expect(variation.status).toBe(201);
      expect(variation.body.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');
      expect(variation.body.approvalPolicySnapshot.reason).toBeTruthy();
    });

    it('a deduction (negative amountDelta) is evaluated on its magnitude, not silently treated as NONE', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);
      const workOrderId = await awardedWorkOrder(accessToken, 500);

      const variation = await request(app)
        .post(`/api/v1/work-order-variations/work-order/${workOrderId}`)
        .set(authHeader(accessToken))
        .send({ description: 'Scope reduced — credit', amountDelta: -6000 });

      expect(variation.body.requiredWorkflowMode).toBe('APPROVAL_THEN_SIGNATURE');
    });

    it('with no policy configured, a variation resolves no requirement (never a silent bypass, never a fabricated one)', async () => {
      const { accessToken } = await registerTestUser(app);
      const workOrderId = await awardedWorkOrder(accessToken, 500);

      const variation = await request(app)
        .post(`/api/v1/work-order-variations/work-order/${workOrderId}`)
        .set(authHeader(accessToken))
        .send({ description: 'Extra ducting found', amountDelta: 6000 });

      expect(variation.body.requiredWorkflowMode).toBeNull();
    });
  });

  describe('disable', () => {
    it('disabling preserves the rules and behaves like "not configured" for resolution', async () => {
      const { accessToken } = await registerTestUser(app);
      await request(app)
        .put('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken))
        .send(threeTierPolicy);

      const disableRes = await request(app)
        .post('/api/v1/organisations/me/approval-policy/disable')
        .set(authHeader(accessToken));
      expect(disableRes.status).toBe(200);
      expect(disableRes.body.enabled).toBe(false);

      const policy = await request(app)
        .get('/api/v1/organisations/me/approval-policy')
        .set(authHeader(accessToken));
      expect(policy.body.rules).toHaveLength(3);

      const { quoteId } = await setupWorkOrderWithContractor(accessToken, 7500);
      const quote = await request(app)
        .get(`/api/v1/quotes/${quoteId}`)
        .set(authHeader(accessToken));
      expect(quote.body.workflowMode).toBeNull();
    });
  });
});
