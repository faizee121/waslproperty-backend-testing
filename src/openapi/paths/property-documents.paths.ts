import { z } from 'zod';
import {
  presignPropertyDocumentSchema,
  registerPropertyDocumentSchema,
  updateDraftSchema,
} from '../../modules/property-documents/property-documents.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import {
  documentValidationIssueSchema,
  propertyDetailSchema,
  propertyDocumentSchema,
} from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Property Documents';

const docIdParam = registry.register('PropertyDocumentIdParam', z.object({ id: z.string() }));

const presignedUploadSchema = registry.register(
  'PropertyDocumentPresignedUpload',
  z.object({
    uploadUrl: z.string().url().openapi({
      description:
        'Synthetic example — a real presigned S3 PUT URL is time-limited and single-use.',
      example: 'https://s3.example.com/wasl-property-uploads/<storage-key>?X-Amz-Signature=...',
    }),
    storageKey: z.string().openapi({ example: 'org_abc123/property-documents/doc_xyz.pdf' }),
    expiresInSeconds: z.number().int(),
  }),
);

const documentWithIssuesSchema = registry.register(
  'PropertyDocumentWithIssues',
  propertyDocumentSchema.extend({
    issues: z.array(documentValidationIssueSchema).openapi({
      description:
        'BLOCKING issues must be resolved before confirmation; WARNING issues do not block it.',
    }),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/property-documents/presign',
  operationId: 'presignPropertyDocument',
  tags: [TAG],
  summary: 'Requests a presigned upload URL for a property document (PDF only).',
  description:
    'Requires both `property.manage` and `strata.manage` — this flow creates a Property AND its strata setup in one confirmed action.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: presignPropertyDocumentSchema } } } },
  responses: {
    200: jsonContent(presignedUploadSchema, 'Presigned upload.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/property-documents',
  operationId: 'registerPropertyDocument',
  tags: [TAG],
  summary: 'Registers an uploaded document and starts analysis.',
  description:
    'Analysis runs asynchronously (fire-and-forget, in-process — see Technical Architecture → ' +
    'Background Processing for the known limitation here). Poll GET /property-documents/{id} for status.',
  security: SECURITY_CUSTOMER,
  request: {
    body: { content: { 'application/json': { schema: registerPropertyDocumentSchema } } },
  },
  responses: {
    201: jsonContent(propertyDocumentSchema, 'Registered; status UPLOADED or ANALYSING.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/property-documents/{id}',
  operationId: 'getPropertyDocument',
  tags: [TAG],
  summary: 'Returns a document’s status and current draft (if analysis has produced one).',
  description:
    'Extracted data in `draft` is proposed data until explicitly confirmed — never ' +
    'auto-applied. See Property Document Intelligence → Human Review & Confirmation.',
  security: SECURITY_CUSTOMER,
  request: { params: docIdParam },
  responses: {
    200: jsonContent(documentWithIssuesSchema, 'The document.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/property-documents/{id}/source-url',
  operationId: 'getPropertyDocumentSourceUrl',
  tags: [TAG],
  summary: 'Returns a short-lived presigned URL to view the original uploaded PDF.',
  security: SECURITY_CUSTOMER,
  request: { params: docIdParam },
  responses: {
    200: jsonContent(
      z.object({ url: z.string().url(), expiresInSeconds: z.number().int() }),
      'Presigned view URL.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/property-documents/{id}/draft',
  operationId: 'updatePropertyDocumentDraft',
  tags: [TAG],
  summary: 'Applies the reviewer’s corrections to the current draft.',
  description:
    'Never triggers re-analysis. The original frozen extraction remains separately recoverable.',
  security: SECURITY_CUSTOMER,
  request: {
    params: docIdParam,
    body: { content: { 'application/json': { schema: updateDraftSchema } } },
  },
  responses: {
    200: jsonContent(documentWithIssuesSchema, 'Updated draft.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/property-documents/{id}/retry',
  operationId: 'retryPropertyDocumentAnalysis',
  tags: [TAG],
  summary: 'Retries analysis after a FAILED attempt.',
  description:
    'Bounded — at most a small fixed number of attempts per document (see DocumentAnalysis).',
  security: SECURITY_CUSTOMER,
  request: { params: docIdParam },
  responses: {
    200: jsonContent(propertyDocumentSchema, 'Re-analysis started.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/property-documents/{id}/confirm',
  operationId: 'confirmPropertyDocument',
  tags: [TAG],
  summary: 'Confirms the reviewed draft, creating the real Property and its Lots.',
  description:
    'The sole creation gate — idempotent (confirming an already-confirmed document returns the ' +
    'existing property rather than creating a duplicate). Blocked while BLOCKING validation issues remain.',
  security: SECURITY_CUSTOMER,
  request: { params: docIdParam },
  responses: {
    200: jsonContent(propertyDetailSchema, 'The created (or already-existing) property.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});
