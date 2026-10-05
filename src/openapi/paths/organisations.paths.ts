import { z } from 'zod';
import { updateOrganisationSchema } from '../../modules/organisations/organisations.schemas.js';
import { upsertApprovalPolicySchema } from '../../modules/approval-policy/approval-policy.schemas.js';
import {
  rolePermissionsRoleParamSchema,
  updateRolePermissionsSchema,
} from '../../modules/role-permissions/role-permissions.schemas.js';
import {
  createComplianceRequirementSchema,
  updateComplianceRequirementSchema,
} from '../../modules/contractors/compliance/compliance.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { organisationSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG_ORG = 'Organisations';
const TAG_APPROVALS = 'Approvals';
const TAG_CONTRACTORS = 'Contractors';

const idParams = registry.register('IdParam', z.object({ id: z.string() }));

registry.registerPath({
  method: 'get',
  path: '/organisations/me',
  operationId: 'getCurrentOrganisation',
  tags: [TAG_ORG],
  summary: "Returns the authenticated caller's organisation.",
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(organisationSchema, 'The current organisation.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/organisations/me',
  operationId: 'updateOrganisation',
  tags: [TAG_ORG],
  summary: "Updates the organisation's currency, jurisdiction, or Wasl AI opt-in.",
  description:
    'Requires OWNER or ADMIN. Jurisdiction (`countryCode`) drives feature gating ' +
    '— e.g. Australian Strata only becomes available once set to AU.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: updateOrganisationSchema } } } },
  responses: {
    200: jsonContent(organisationSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

// --- Roles & Permissions (OWNER/ADMIN only) ---

const rolePermissionRowSchema = registry.register(
  'RolePermissionRow',
  z.object({
    role: z.string().openapi({ example: 'PROPERTY_MANAGER' }),
    capability: z.string().openapi({ example: 'maintenance.manage' }),
    grantedByDefault: z.boolean(),
    granted: z
      .boolean()
      .openapi({ description: 'grantedByDefault, unless this org overrides it.' }),
    isOverridden: z.boolean(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/organisations/me/role-permissions',
  operationId: 'getRolePermissions',
  tags: [TAG_ORG],
  summary: 'Lists every PropertyRole’s default and effective capability grants.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.array(rolePermissionRowSchema), 'Full role/capability matrix.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'put',
  path: '/organisations/me/role-permissions/{role}',
  operationId: 'updateRolePermissions',
  tags: [TAG_ORG],
  summary: 'Replaces one PropertyRole’s capability overrides.',
  security: SECURITY_CUSTOMER,
  request: {
    params: rolePermissionsRoleParamSchema,
    body: { content: { 'application/json': { schema: updateRolePermissionsSchema } } },
  },
  responses: {
    200: jsonContent(z.array(rolePermissionRowSchema), 'Updated matrix for this role.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/organisations/me/role-permissions/{role}/reset',
  operationId: 'resetRolePermissions',
  tags: [TAG_ORG],
  summary: 'Clears every override for one role, reverting it to platform defaults.',
  security: SECURITY_CUSTOMER,
  request: { params: rolePermissionsRoleParamSchema },
  responses: {
    200: jsonContent(z.array(rolePermissionRowSchema), 'Reset matrix for this role.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Approval & Acceptance policy (OWNER/ADMIN only) ---

const approvalPolicySchema = registry.register(
  'ApprovalPolicy',
  z.object({
    enabled: z.boolean(),
    currencyCode: z.string(),
    rules: z.array(
      z.object({
        maxAmount: z
          .string()
          .nullable()
          .openapi({ description: 'null on the highest, open-ended band.' }),
        workflowMode: z.enum([
          'NONE',
          'APPROVAL_ONLY',
          'SIGNATURE_ONLY',
          'APPROVAL_THEN_SIGNATURE',
        ]),
      }),
    ),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/organisations/me/approval-policy',
  operationId: 'getApprovalPolicy',
  tags: [TAG_APPROVALS],
  summary: 'Returns the organisation’s configured Approval & Acceptance policy, if any.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(approvalPolicySchema.nullable(), 'Null if never configured.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'put',
  path: '/organisations/me/approval-policy',
  operationId: 'upsertApprovalPolicy',
  tags: [TAG_APPROVALS],
  summary: 'Creates or replaces the organisation’s amount-banded Approval & Acceptance policy.',
  description:
    'Bands are contiguous and non-overlapping by construction: each rule’s lower bound is ' +
    'the previous rule’s maxAmount, and only the last rule may be open-ended. See ' +
    'ADR-006 — WaslSign as a Separate Integrated Product.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: upsertApprovalPolicySchema } } } },
  responses: {
    200: jsonContent(approvalPolicySchema, 'Saved.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/organisations/me/approval-policy/disable',
  operationId: 'disableApprovalPolicy',
  tags: [TAG_APPROVALS],
  summary: 'Disables the policy without deleting its configured rules.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(approvalPolicySchema, 'Disabled.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// Note: resolveApprovalPolicySchema (approval-policy.schemas.ts) backs an
// internal service method (ApprovalPolicyService.resolve), used by Quotes
// and Work Order Variations at creation/award time — it is not exposed as
// its own HTTP endpoint. Confirmed against approval-policy.routes.ts: only
// GET /, PUT /, and POST /disable exist. Do not add a route here without
// first confirming one was actually added to the router.

// --- Contractor Compliance requirements (OWNER/ADMIN only) ---

const complianceRequirementSchema = registry.register(
  'ComplianceRequirement',
  z.object({
    id: z.string(),
    category: z.string().openapi({ example: 'ELECTRICAL' }),
    credentialCategory: z.string().openapi({ example: 'LICENSE' }),
    credentialType: z.string(),
    required: z.boolean(),
    enforcement: z.enum(['BLOCK_ASSIGNMENT', 'WARN_ONLY']),
    mustBeVerified: z.boolean(),
    mustNotBeExpired: z.boolean(),
    minimumCoverageAmount: z.string().nullable(),
    minimumCoverageCurrencyCode: z.string().nullable(),
    notes: z.string().nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/organisations/me/contractor-compliance-requirements',
  operationId: 'listComplianceRequirements',
  tags: [TAG_CONTRACTORS],
  summary: 'Lists the organisation’s configured per-trade credential requirements.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.array(complianceRequirementSchema), 'Configured requirements.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/organisations/me/contractor-compliance-requirements',
  operationId: 'createComplianceRequirement',
  tags: [TAG_CONTRACTORS],
  summary: 'Adds a required credential for a trade category.',
  description:
    'When `enforcement` is BLOCK_ASSIGNMENT, a contractor missing this credential fails ' +
    'eligibility and cannot be awarded or assigned work in that trade — see ' +
    'ContractorEligibilityService.',
  security: SECURITY_CUSTOMER,
  request: {
    body: { content: { 'application/json': { schema: createComplianceRequirementSchema } } },
  },
  responses: {
    201: jsonContent(complianceRequirementSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/organisations/me/contractor-compliance-requirements/{id}',
  operationId: 'updateComplianceRequirement',
  tags: [TAG_CONTRACTORS],
  summary: 'Updates a credential requirement.',
  security: SECURITY_CUSTOMER,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: updateComplianceRequirementSchema } } },
  },
  responses: {
    200: jsonContent(complianceRequirementSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/organisations/me/contractor-compliance-requirements/{id}',
  operationId: 'removeComplianceRequirement',
  tags: [TAG_CONTRACTORS],
  summary: 'Removes a credential requirement.',
  security: SECURITY_CUSTOMER,
  request: { params: idParams },
  responses: {
    204: { description: 'Removed.' },
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});
