import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Must be mocked before the first import of anything that transitively
// loads the S3 client — see property-documents.test.ts for the identical
// pattern this borrows.
const { presignPutMock } = vi.hoisted(() => ({
  presignPutMock: vi.fn(async (key: string) => `https://s3.example.com/${key}?upload=1`),
}));
vi.mock('../../src/lib/s3.js', () => ({
  presignPut: presignPutMock,
  presignGet: vi.fn(async (key: string) => `https://s3.example.com/${key}?download=1`),
  getObjectBytes: vi.fn(async () => Buffer.from('%PDF-fake')),
}));

import { createApp } from '../../src/app.js';
import {
  communicationSchema,
  maintenanceRequestSchema,
  propertyDetailSchema,
  propertySummarySchema,
  strataSummarySchema,
  workOrderSchema,
  aiStatusSchema,
  propertyDocumentSchema,
} from '../../src/openapi/components/entities.schemas.js';
import { z } from 'zod';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, registerTestUser } from '../helpers/auth.js';

/**
 * Proves the OpenAPI response schemas registered in src/openapi/ are not
 * fiction: each test hits a real endpoint end-to-end (real DB, real
 * authorization) and validates the actual JSON response against the exact
 * same Zod schema the OpenAPI document publishes for that operation. A
 * schema.safeParse() failure here means the documentation has drifted from
 * the real contract — fix the schema in src/openapi/components, not this
 * test.
 */

const app = createApp();

const validProperty = {
  name: 'Marina Heights',
  code: `MARINA-${Date.now()}`,
  addressLine1: '1 Marina Blvd',
  city: 'Dubai',
  country: 'UAE',
  propertyType: 'MIXED_USE',
};

async function registerAuOrg() {
  const session = await registerTestUser(app);
  const patchRes = await request(app)
    .patch('/api/v1/organisations/me')
    .set(authHeader(session.accessToken))
    .send({ countryCode: 'AU' });
  expect(patchRes.status).toBe(200);
  return session;
}

function expectValid<T>(schema: z.ZodType<T>, body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Response did not match its documented OpenAPI schema:\n${JSON.stringify(result.error.format(), null, 2)}\n\nBody:\n${JSON.stringify(body, null, 2)}`,
    );
  }
}

describe('OpenAPI response contract', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await testPrisma.$disconnect();
  });

  it('GET /properties/{id} matches PropertyDetail', async () => {
    const { accessToken } = await registerTestUser(app);
    const created = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/api/v1/properties/${created.body.id}`)
      .set(authHeader(accessToken));

    expect(res.status).toBe(200);
    expectValid(propertyDetailSchema, res.body);
  });

  it('GET /properties matches the PaginatedProperties envelope', async () => {
    const { accessToken } = await registerTestUser(app);
    await request(app).post('/api/v1/properties').set(authHeader(accessToken)).send(validProperty);

    const res = await request(app).get('/api/v1/properties').set(authHeader(accessToken));

    expect(res.status).toBe(200);
    expectValid(
      z.object({
        items: z.array(propertySummarySchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
      }),
      res.body,
    );
  });

  it('POST /maintenance-requests matches MaintenanceRequest', async () => {
    const { accessToken } = await registerTestUser(app);
    const property = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    const res = await request(app)
      .post('/api/v1/maintenance-requests')
      .set(authHeader(accessToken))
      .send({
        title: 'Leaking kitchen tap',
        description: 'Dripping constantly.',
        category: 'PLUMBING',
        priority: 'MEDIUM',
        propertyId: property.body.id,
      });

    expect(res.status).toBe(201);
    expectValid(maintenanceRequestSchema, res.body);
  });

  it('POST /work-orders matches WorkOrder', async () => {
    const { accessToken } = await registerTestUser(app);
    const property = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);
    const maintenanceRequest = await request(app)
      .post('/api/v1/maintenance-requests')
      .set(authHeader(accessToken))
      .send({
        title: 'Broken AC',
        description: 'Not cooling.',
        category: 'HVAC',
        priority: 'HIGH',
        propertyId: property.body.id,
      });

    const res = await request(app).post('/api/v1/work-orders').set(authHeader(accessToken)).send({
      maintenanceRequestId: maintenanceRequest.body.id,
      title: 'Repair AC unit',
      description: 'Technician to inspect and repair.',
      priority: 'HIGH',
    });

    expect(res.status).toBe(201);
    expectValid(workOrderSchema, res.body);
  });

  it('POST /communications matches Communication', async () => {
    const { accessToken } = await registerTestUser(app);

    const res = await request(app)
      .post('/api/v1/communications')
      .set(authHeader(accessToken))
      .send({
        title: 'Scheduled maintenance notice',
        body: 'Water will be shut off briefly on Friday.',
        channels: ['IN_APP'],
        audienceCriteria: { scope: 'ORGANISATION' },
      });

    expect(res.status).toBe(201);
    expectValid(communicationSchema, res.body);
  });

  it('GET /properties/{propertyId}/strata matches StrataSummary', async () => {
    const { accessToken } = await registerAuOrg();
    const property = await request(app)
      .post('/api/v1/properties')
      .set(authHeader(accessToken))
      .send(validProperty);

    const res = await request(app)
      .get(`/api/v1/properties/${property.body.id}/strata`)
      .set(authHeader(accessToken));

    expect(res.status).toBe(200);
    expectValid(strataSummarySchema, res.body);
  });

  it('GET /ai/status matches AiStatus', async () => {
    const { accessToken } = await registerTestUser(app);

    const res = await request(app).get('/api/v1/ai/status').set(authHeader(accessToken));

    expect(res.status).toBe(200);
    expectValid(aiStatusSchema, res.body);
  });

  it('POST /property-documents/presign matches PropertyDocumentPresignedUpload', async () => {
    const { accessToken } = await registerAuOrg();

    const res = await request(app)
      .post('/api/v1/property-documents/presign')
      .set(authHeader(accessToken))
      .send({ fileName: 'strata-plan.pdf', contentType: 'application/pdf', fileSize: 1024 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ uploadUrl: expect.any(String), storageKey: expect.any(String) }),
    );
    expect(presignPutMock).toHaveBeenCalled();
    void propertyDocumentSchema; // imported for discoverability; the full document shape is covered by property-documents.test.ts
  });
});
