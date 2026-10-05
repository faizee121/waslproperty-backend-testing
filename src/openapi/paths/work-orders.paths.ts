import { z } from 'zod';
import {
  assignContractorSchema,
  createWorkOrderSchema,
  updateCostSchema,
  updateStatusSchema as updateWorkOrderStatusSchema,
  workOrderQuerySchema,
} from '../../modules/work-orders/work-orders.schemas.js';
import {
  createVariationSchema,
  presignVariationAttachmentSchema,
  registerVariationAttachmentSchema,
  rejectVariationSchema,
  setVariationWorkflowModeSchema,
} from '../../modules/work-orders/work-order-variations.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import {
  commercialSummarySchema,
  contractorEligibilitySchema,
  workOrderSchema,
  workOrderVariationSchema,
} from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG_WO = 'Work Orders';
const TAG_VAR = 'Variations';

const workOrderIdParam = registry.register('WorkOrderIdParam', z.object({ id: z.string() }));
const workOrderIdPathParam = registry.register(
  'WorkOrderIdPathParam',
  z.object({ workOrderId: z.string() }),
);
const maintenanceRequestIdParam = registry.register(
  'WorkOrderMaintenanceRequestIdParam',
  z.object({ maintenanceRequestId: z.string() }),
);
const variationIdParam = registry.register('VariationIdParam', z.object({ id: z.string() }));

const variationAttachmentSchema = registry.register(
  'VariationAttachment',
  z.object({
    id: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number().int(),
    createdAt: z.string().datetime(),
  }),
);

// --- Work Orders ---

registry.registerPath({
  method: 'get',
  path: '/work-orders',
  operationId: 'listWorkOrders',
  tags: [TAG_WO],
  summary: 'Lists work orders visible to the caller.',
  description:
    'Requires `work_orders.view`. Never resident-visible — work orders carry cost/contractor data.',
  security: SECURITY_CUSTOMER,
  request: { query: workOrderQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(workOrderSchema, 'WorkOrders'), 'Visible work orders.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-orders',
  operationId: 'createWorkOrder',
  tags: [TAG_WO],
  summary: 'Creates a work order directly against a maintenance request (Direct Work path).',
  description: 'Requires `work_orders.manage` on the maintenance request’s property.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createWorkOrderSchema } } } },
  responses: {
    201: jsonContent(workOrderSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/work-orders/by-request/{maintenanceRequestId}',
  operationId: 'getWorkOrderByMaintenanceRequest',
  tags: [TAG_WO],
  summary: 'Returns the work order (if any) for a maintenance request.',
  description: 'Requires `work_orders.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: maintenanceRequestIdParam },
  responses: {
    200: jsonContent(workOrderSchema, 'The work order.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/work-orders/{id}',
  operationId: 'getWorkOrder',
  tags: [TAG_WO],
  summary: 'Returns one work order.',
  description: 'Requires `work_orders.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: workOrderIdParam },
  responses: {
    200: jsonContent(workOrderSchema, 'The work order.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/work-orders/{id}/status',
  operationId: 'updateWorkOrderStatus',
  tags: [TAG_WO],
  summary: 'Transitions a work order’s status.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: workOrderIdParam,
    body: { content: { 'application/json': { schema: updateWorkOrderStatusSchema } } },
  },
  responses: {
    200: jsonContent(workOrderSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/work-orders/{id}/contractor-eligibility',
  operationId: 'getWorkOrderContractorEligibility',
  tags: [TAG_WO],
  summary: 'Checks whether the currently assigned contractor still passes eligibility.',
  description:
    'Requires `work_orders.manage`. Eligibility is re-evaluated server-side, never cached from award time.',
  security: SECURITY_CUSTOMER,
  request: { params: workOrderIdParam },
  responses: {
    200: jsonContent(contractorEligibilitySchema, 'Eligibility result.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/work-orders/{id}/contractor',
  operationId: 'assignWorkOrderContractor',
  tags: [TAG_WO],
  summary: 'Assigns (or reassigns) the contractor on a work order.',
  description: 'Requires `work_orders.manage`. Re-checks eligibility server-side before assigning.',
  security: SECURITY_CUSTOMER,
  request: {
    params: workOrderIdParam,
    body: { content: { 'application/json': { schema: assignContractorSchema } } },
  },
  responses: {
    200: jsonContent(workOrderSchema, 'Assigned.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/work-orders/{id}/cost',
  operationId: 'updateWorkOrderCost',
  tags: [TAG_WO],
  summary: 'Records estimated and/or actual cost on a work order.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: workOrderIdParam,
    body: { content: { 'application/json': { schema: updateCostSchema } } },
  },
  responses: {
    200: jsonContent(workOrderSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

// --- Work Order Variations ---

registry.registerPath({
  method: 'get',
  path: '/work-order-variations/work-order/{workOrderId}',
  operationId: 'listVariations',
  tags: [TAG_VAR],
  summary: 'Lists the variations recorded against a work order.',
  description: 'Requires `work_orders.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: workOrderIdPathParam },
  responses: {
    200: jsonContent(z.array(workOrderVariationSchema), 'Variations.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/work-order-variations/work-order/{workOrderId}/commercial-summary',
  operationId: 'getCommercialSummary',
  tags: [TAG_VAR],
  summary: 'Returns the work order’s authorised total (original cost + approved variations).',
  description: 'Requires `work_orders.view`. Always computed at read time, never stored.',
  security: SECURITY_CUSTOMER,
  request: { params: workOrderIdPathParam },
  responses: {
    200: jsonContent(commercialSummarySchema, 'Commercial summary.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-order-variations/work-order/{workOrderId}',
  operationId: 'createVariation',
  tags: [TAG_VAR],
  summary: 'Records a new variation (scope/cost change) against a work order.',
  description:
    'Requires `work_orders.manage`. The required workflow mode is resolved once, immediately, ' +
    'from the organisation’s Approval Policy, evaluating the variation amount itself.',
  security: SECURITY_CUSTOMER,
  request: {
    params: workOrderIdPathParam,
    body: { content: { 'application/json': { schema: createVariationSchema } } },
  },
  responses: {
    201: jsonContent(workOrderVariationSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/work-order-variations/{id}/workflow-mode',
  operationId: 'setVariationWorkflowMode',
  tags: [TAG_VAR],
  summary: 'Chooses the Approval & Acceptance workflow for this variation.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: variationIdParam,
    body: { content: { 'application/json': { schema: setVariationWorkflowModeSchema } } },
  },
  responses: {
    200: jsonContent(workOrderVariationSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-order-variations/{id}/approve',
  operationId: 'approveVariation',
  tags: [TAG_VAR],
  summary: 'Approves a variation under the native WaslProp Approval workflow.',
  description: 'Requires `quotes.approve`.',
  security: SECURITY_CUSTOMER,
  request: { params: variationIdParam },
  responses: {
    200: jsonContent(workOrderVariationSchema, 'Approved.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-order-variations/{id}/reject',
  operationId: 'rejectVariation',
  tags: [TAG_VAR],
  summary: 'Rejects a variation.',
  description: 'Requires `quotes.approve`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: variationIdParam,
    body: { content: { 'application/json': { schema: rejectVariationSchema } } },
  },
  responses: {
    200: jsonContent(workOrderVariationSchema, 'Rejected.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-order-variations/{id}/cancel',
  operationId: 'cancelVariation',
  tags: [TAG_VAR],
  summary: 'Cancels a pending variation.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: variationIdParam },
  responses: {
    200: jsonContent(workOrderVariationSchema, 'Cancelled.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/work-order-variations/{id}/attachments/presign',
  operationId: 'presignVariationAttachment',
  tags: [TAG_VAR],
  summary: 'Requests a presigned upload URL for a variation document.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: variationIdParam,
    body: { content: { 'application/json': { schema: presignVariationAttachmentSchema } } },
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
  path: '/work-order-variations/{id}/attachments',
  operationId: 'registerVariationAttachment',
  tags: [TAG_VAR],
  summary: 'Registers a variation attachment after upload.',
  description: 'Requires `work_orders.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: variationIdParam,
    body: { content: { 'application/json': { schema: registerVariationAttachmentSchema } } },
  },
  responses: {
    201: jsonContent(variationAttachmentSchema, 'Registered.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/work-order-variations/{id}/attachments',
  operationId: 'listVariationAttachments',
  tags: [TAG_VAR],
  summary: 'Lists a variation’s attachments.',
  description: 'Requires `work_orders.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: variationIdParam },
  responses: {
    200: jsonContent(z.array(variationAttachmentSchema), 'Attachments.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});
