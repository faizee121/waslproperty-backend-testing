import { z } from 'zod';
import {
  createContractorSchema,
  contractorQuerySchema,
  updateContractorSchema,
} from '../../modules/contractors/contractors.schemas.js';
import {
  createCredentialSchema,
  presignCredentialDocumentSchema,
  rejectCredentialSchema,
  updateCredentialSchema,
  verifyCredentialSchema,
} from '../../modules/contractors/compliance/compliance.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import { contractorSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Contractors';

const contractorIdParam = registry.register('ContractorIdParam', z.object({ id: z.string() }));
const contractorIdPathParam = registry.register(
  'ContractorIdPathParam',
  z.object({ contractorId: z.string() }),
);
const credentialIdParams = registry.register(
  'CredentialIdParams',
  z.object({ contractorId: z.string(), credentialId: z.string() }),
);

const credentialSchema = registry.register(
  'ContractorCredential',
  z.object({
    id: z.string(),
    category: z.string().openapi({ example: 'LICENSE' }),
    type: z.string(),
    credentialNumber: z.string().nullable(),
    issuer: z.string().nullable(),
    issuedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    coverageAmount: z.string().nullable(),
    coverageCurrencyCode: z.string().nullable(),
    status: z.enum(['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'EXPIRED']),
    notes: z.string().nullable(),
  }),
);

const complianceOverviewSchema = registry.register(
  'ContractorComplianceOverview',
  z.object({
    contractorId: z.string(),
    eligibleTrades: z.array(z.string()),
    credentials: z.array(credentialSchema),
    outstandingRequirements: z.array(
      z.object({ category: z.string(), credentialType: z.string(), reason: z.string() }),
    ),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/contractors/credential-types',
  operationId: 'listCommonCredentialTypes',
  tags: [TAG],
  summary: 'Lists commonly-used credential type names, to populate an autocomplete.',
  description: 'Requires `contractor_compliance.view`.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.array(z.string()), 'Suggested credential type names.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/contractors',
  operationId: 'listContractors',
  tags: [TAG],
  summary: 'Lists the organisation’s contractor directory.',
  description:
    'Requires `contractors.view` on at least one assigned property (organisation-wide directory, not property-scoped).',
  security: SECURITY_CUSTOMER,
  request: { query: contractorQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(contractorSchema, 'Contractors'), 'Contractors.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/contractors',
  operationId: 'createContractor',
  tags: [TAG],
  summary: 'Adds a contractor to the organisation’s directory.',
  description: 'Requires `contractors.manage`.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createContractorSchema } } } },
  responses: {
    201: jsonContent(contractorSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/contractors/{id}',
  operationId: 'getContractor',
  tags: [TAG],
  summary: 'Returns one contractor.',
  description: 'Requires `contractors.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: contractorIdParam },
  responses: {
    200: jsonContent(contractorSchema, 'The contractor.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/contractors/{id}',
  operationId: 'updateContractor',
  tags: [TAG],
  summary: 'Updates a contractor.',
  description: 'Requires `contractors.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: contractorIdParam,
    body: { content: { 'application/json': { schema: updateContractorSchema } } },
  },
  responses: {
    200: jsonContent(contractorSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/contractors/{contractorId}/compliance',
  operationId: 'getContractorComplianceOverview',
  tags: [TAG],
  summary:
    'Returns a contractor’s full compliance picture: credentials held and requirements outstanding.',
  description: 'Requires `contractor_compliance.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: contractorIdPathParam },
  responses: {
    200: jsonContent(complianceOverviewSchema, 'Compliance overview.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/contractors/{contractorId}/credentials',
  operationId: 'listCredentials',
  tags: [TAG],
  summary: 'Lists a contractor’s credentials.',
  description: 'Requires `contractor_compliance.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: contractorIdPathParam },
  responses: {
    200: jsonContent(z.array(credentialSchema), 'Credentials.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/contractors/{contractorId}/credentials/presign',
  operationId: 'presignCredentialDocument',
  tags: [TAG],
  summary: 'Requests a presigned upload URL for a credential document.',
  description: 'Requires `contractor_compliance.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: contractorIdPathParam,
    body: { content: { 'application/json': { schema: presignCredentialDocumentSchema } } },
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
  path: '/contractors/{contractorId}/credentials',
  operationId: 'createCredential',
  tags: [TAG],
  summary: 'Records a credential for a contractor.',
  description: 'Requires `contractor_compliance.manage`. Starts as PENDING_VERIFICATION.',
  security: SECURITY_CUSTOMER,
  request: {
    params: contractorIdPathParam,
    body: { content: { 'application/json': { schema: createCredentialSchema } } },
  },
  responses: {
    201: jsonContent(credentialSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/contractors/{contractorId}/credentials/{credentialId}',
  operationId: 'updateCredential',
  tags: [TAG],
  summary: 'Updates a credential’s details.',
  description: 'Requires `contractor_compliance.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: credentialIdParams,
    body: { content: { 'application/json': { schema: updateCredentialSchema } } },
  },
  responses: {
    200: jsonContent(credentialSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/contractors/{contractorId}/credentials/{credentialId}',
  operationId: 'removeCredential',
  tags: [TAG],
  summary: 'Removes a credential.',
  description: 'Requires `contractor_compliance.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: credentialIdParams },
  responses: {
    204: { description: 'Removed.' },
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/contractors/{contractorId}/credentials/{credentialId}/verify',
  operationId: 'verifyCredential',
  tags: [TAG],
  summary: 'Marks a credential as verified.',
  description: 'Requires `contractor_compliance.verify` — a narrower capability than `.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: credentialIdParams,
    body: { content: { 'application/json': { schema: verifyCredentialSchema } } },
  },
  responses: {
    200: jsonContent(credentialSchema, 'Verified.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/contractors/{contractorId}/credentials/{credentialId}/reject',
  operationId: 'rejectCredential',
  tags: [TAG],
  summary: 'Rejects a credential, requiring a reason.',
  description: 'Requires `contractor_compliance.verify`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: credentialIdParams,
    body: { content: { 'application/json': { schema: rejectCredentialSchema } } },
  },
  responses: {
    200: jsonContent(credentialSchema, 'Rejected.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});
