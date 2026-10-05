import { z } from 'zod';
import {
  createQuoteSchema,
  rejectQuoteSchema,
  setWorkflowModeSchema,
  submitQuoteSchema,
} from '../../modules/quotes/quotes.schemas.js';
import {
  awardQuoteRoundSchema,
  cancelQuoteRoundSchema,
  createQuoteRoundSchema,
  inviteContractorsSchema,
  presignQuoteAttachmentSchema,
  rfqPublicSubmitSchema,
} from '../../modules/quotes/quote-rounds.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import {
  contractorQuoteSchema,
  contractorSchema,
  quoteRoundSchema,
} from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER, SECURITY_PUBLIC } from '../registry.js';

const TAG = 'Procurement';

const quoteIdParam = registry.register('QuoteIdParam', z.object({ id: z.string() }));
const quoteRoundIdParam = registry.register('QuoteRoundIdParam', z.object({ id: z.string() }));
const maintenanceRequestIdParam = registry.register(
  'QuoteMaintenanceRequestIdParam',
  z.object({ maintenanceRequestId: z.string() }),
);
const rfqTokenParam = registry.register('RfqTokenParam', z.object({ token: z.string() }));

const attachmentSchema = registry.register(
  'QuoteAttachment',
  z.object({
    id: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number().int(),
    createdAt: z.string().datetime(),
  }),
);

// --- Quotes ---

registry.registerPath({
  method: 'post',
  path: '/quotes',
  operationId: 'createQuote',
  tags: [TAG],
  summary: 'Records a quote directly against a Work Order (the pre-M11 "Direct Work" path).',
  description: 'Requires `quotes.manage` on the work order’s property.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createQuoteSchema } } } },
  responses: {
    201: jsonContent(contractorQuoteSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/quotes/{id}',
  operationId: 'getQuote',
  tags: [TAG],
  summary: 'Returns one quote.',
  description: 'Requires `quotes.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'The quote.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/quotes/{id}/submit',
  operationId: 'submitQuote',
  tags: [TAG],
  summary: 'Records a contractor’s commercial response on their behalf (staff-entered).',
  description:
    'Requires `quotes.manage`. A contractor submitting through their own RFQ link uses the public endpoint instead.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteIdParam,
    body: { content: { 'application/json': { schema: submitQuoteSchema } } },
  },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Submitted.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/quotes/{id}/workflow-mode',
  operationId: 'setQuoteWorkflowMode',
  tags: [TAG],
  summary:
    'Chooses the Approval & Acceptance workflow for this quote (NONE/approval/signature/both).',
  description:
    'Requires `quotes.manage`. Must meet or exceed the organisation’s policy-required minimum.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteIdParam,
    body: { content: { 'application/json': { schema: setWorkflowModeSchema } } },
  },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/quotes/{id}/decline',
  operationId: 'declineQuote',
  tags: [TAG],
  summary: 'Records that a contractor declined to quote.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Declined.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/quotes/{id}/withdraw',
  operationId: 'withdrawQuote',
  tags: [TAG],
  summary: 'Withdraws a previously submitted quote.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Withdrawn.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quotes/{id}/approve',
  operationId: 'approveQuote',
  tags: [TAG],
  summary: 'Approves a quote under the native WaslProp Approval workflow.',
  description:
    'Requires `quotes.approve`. Only meaningful when workflowMode includes APPROVAL_ONLY.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Approved.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quotes/{id}/reject',
  operationId: 'rejectQuote',
  tags: [TAG],
  summary: 'Rejects a quote under the native WaslProp Approval workflow.',
  description: 'Requires `quotes.approve`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteIdParam,
    body: { content: { 'application/json': { schema: rejectQuoteSchema } } },
  },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Rejected.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

// --- Quote Rounds (RFQ) ---

registry.registerPath({
  method: 'post',
  path: '/quote-rounds',
  operationId: 'createQuoteRound',
  tags: [TAG],
  summary:
    'Opens a new Request for Quote (RFQ) round for a maintenance request, inviting contractors immediately.',
  description: 'Requires `quotes.manage` on the maintenance request’s property.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createQuoteRoundSchema } } } },
  responses: {
    201: jsonContent(quoteRoundSchema, 'Opened and invitations sent.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/quote-rounds/by-request/{maintenanceRequestId}',
  operationId: 'getQuoteRoundByMaintenanceRequest',
  tags: [TAG],
  summary: 'Returns the RFQ round (if any) for a maintenance request.',
  description: 'Requires `quotes.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: maintenanceRequestIdParam },
  responses: {
    200: jsonContent(quoteRoundSchema, 'The round.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/quote-rounds/by-request/{maintenanceRequestId}/eligible-contractors',
  operationId: 'getEligibleContractorsForRequest',
  tags: [TAG],
  summary:
    'Lists contractors eligible to be invited to quote on this request, based on trade and compliance.',
  description: 'Requires `quotes.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: maintenanceRequestIdParam },
  responses: {
    200: jsonContent(z.array(contractorSchema), 'Eligible contractors.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/quote-rounds/{id}',
  operationId: 'getQuoteRound',
  tags: [TAG],
  summary: 'Returns one RFQ round, including invitations and submitted quotes.',
  description: 'Requires `quotes.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteRoundIdParam },
  responses: {
    200: jsonContent(quoteRoundSchema, 'The round.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quote-rounds/{id}/invitations',
  operationId: 'inviteContractors',
  tags: [TAG],
  summary: 'Invites additional contractors to an open RFQ round.',
  description: 'Requires `quotes.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteRoundIdParam,
    body: { content: { 'application/json': { schema: inviteContractorsSchema } } },
  },
  responses: {
    200: jsonContent(quoteRoundSchema, 'Invitations sent.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quote-rounds/{id}/award',
  operationId: 'awardQuoteRound',
  tags: [TAG],
  summary:
    'Awards the round to one contractor’s quote, re-checking eligibility and creating the Work Order.',
  description:
    'Requires `quotes.approve`. Fails with 409 if the chosen contractor no longer passes eligibility.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteRoundIdParam,
    body: { content: { 'application/json': { schema: awardQuoteRoundSchema } } },
  },
  responses: {
    200: jsonContent(quoteRoundSchema, 'Awarded.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quote-rounds/{id}/cancel',
  operationId: 'cancelQuoteRound',
  tags: [TAG],
  summary: 'Cancels an open RFQ round.',
  description: 'Requires `quotes.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteRoundIdParam,
    body: { content: { 'application/json': { schema: cancelQuoteRoundSchema } } },
  },
  responses: {
    200: jsonContent(quoteRoundSchema, 'Cancelled.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quote-rounds/quotes/{id}/attachments/presign',
  operationId: 'presignQuoteAttachment',
  tags: [TAG],
  summary: 'Requests a presigned upload URL for a quote document.',
  description: 'Requires `quotes.manage` (staff uploading on a contractor’s behalf).',
  security: SECURITY_CUSTOMER,
  request: {
    params: quoteIdParam,
    body: { content: { 'application/json': { schema: presignQuoteAttachmentSchema } } },
  },
  responses: {
    200: jsonContent(
      z.object({
        uploadUrl: z.string().url(),
        storageKey: z.string(),
        expiresInSeconds: z.number().int(),
      }),
      'Presigned upload.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/quote-rounds/quotes/{id}/attachments',
  operationId: 'registerQuoteAttachment',
  tags: [TAG],
  summary: 'Registers a quote attachment after upload.',
  description: 'Requires `quotes.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    201: jsonContent(attachmentSchema, 'Registered.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/quote-rounds/quotes/{id}/attachments',
  operationId: 'listQuoteAttachments',
  tags: [TAG],
  summary: 'Lists a quote’s attachments.',
  description: 'Requires `quotes.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: quoteIdParam },
  responses: {
    200: jsonContent(z.array(attachmentSchema), 'Attachments.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Public (token-based) RFQ contractor response ---

registry.registerPath({
  method: 'get',
  path: '/rfq/{token}',
  operationId: 'getRfqInvitation',
  tags: [TAG],
  summary:
    'Public — a contractor views an RFQ invitation via their secure link. No account required.',
  description:
    'Unauthenticated. Resolved purely from the high-entropy token in the URL — see Security → File Security.',
  security: SECURITY_PUBLIC,
  request: { params: rfqTokenParam },
  responses: {
    200: jsonContent(quoteRoundSchema, 'The RFQ (scoped to what a contractor should see).'),
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/rfq/{token}/submit',
  operationId: 'submitRfqResponse',
  tags: [TAG],
  summary: 'Public — a contractor submits their quote through their secure link.',
  security: SECURITY_PUBLIC,
  request: {
    params: rfqTokenParam,
    body: { content: { 'application/json': { schema: rfqPublicSubmitSchema } } },
  },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Submitted.'),
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/rfq/{token}/decline',
  operationId: 'declineRfqResponse',
  tags: [TAG],
  summary: 'Public — a contractor declines to quote through their secure link.',
  security: SECURITY_PUBLIC,
  request: { params: rfqTokenParam },
  responses: {
    200: jsonContent(contractorQuoteSchema, 'Declined.'),
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/rfq/{token}/attachments/presign',
  operationId: 'presignRfqAttachment',
  tags: [TAG],
  summary: 'Public — requests a presigned upload URL for a quote document, via the secure link.',
  security: SECURITY_PUBLIC,
  request: {
    params: rfqTokenParam,
    body: { content: { 'application/json': { schema: presignQuoteAttachmentSchema } } },
  },
  responses: {
    200: jsonContent(
      z.object({
        uploadUrl: z.string().url(),
        storageKey: z.string(),
        expiresInSeconds: z.number().int(),
      }),
      'Presigned upload.',
    ),
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/rfq/{token}/attachments',
  operationId: 'registerRfqAttachment',
  tags: [TAG],
  summary: 'Public — registers a quote attachment after upload, via the secure link.',
  security: SECURITY_PUBLIC,
  request: { params: rfqTokenParam },
  responses: {
    201: jsonContent(attachmentSchema, 'Registered.'),
    404: commonErrors[404],
  },
});
