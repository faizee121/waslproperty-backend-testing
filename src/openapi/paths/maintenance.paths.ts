import { z } from 'zod';
import {
  presignAttachmentsSchema,
  registerAttachmentsSchema,
} from '../../modules/maintenance/attachments.schemas.js';
import {
  createMaintenanceRequestSchema,
  maintenanceRequestQuerySchema,
  updateMaintenanceRequestSchema,
  updateStatusSchema,
} from '../../modules/maintenance/maintenance.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import { maintenanceRequestSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Maintenance';

const requestIdParam = registry.register('MaintenanceRequestIdParam', z.object({ id: z.string() }));

const presignedUploadSchema = registry.register(
  'PresignedUpload',
  z.object({
    uploadUrl: z.string().url().openapi({
      description:
        'Synthetic example — a real presigned S3 PUT URL is time-limited and single-use.',
      example: 'https://s3.example.com/wasl-property-uploads/<storage-key>?X-Amz-Signature=...',
    }),
    storageKey: z.string().openapi({ example: 'org_abc123/maintenance/mr_xyz/photo-1.jpg' }),
    expiresInSeconds: z.number().int(),
  }),
);

const attachmentSchema = registry.register(
  'MaintenanceAttachment',
  z.object({
    id: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    createdAt: z.string().datetime(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/maintenance-requests',
  operationId: 'listMaintenanceRequests',
  tags: [TAG],
  summary: 'Lists maintenance requests visible to the caller.',
  description:
    'Three visibility tiers, resolved server-side: org staff see every request; a property-scoped ' +
    'manager with `maintenance.view` sees requests on their assigned properties; everyone else ' +
    '(a resident/tenant, or a role stripped of `maintenance.view`) sees only requests they personally reported.',
  security: SECURITY_CUSTOMER,
  request: { query: maintenanceRequestQuerySchema },
  responses: {
    200: jsonContent(
      paginatedSchema(maintenanceRequestSchema, 'MaintenanceRequests'),
      'Visible maintenance requests.',
    ),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/maintenance-requests',
  operationId: 'createMaintenanceRequest',
  tags: [TAG],
  summary: 'Reports a new maintenance issue.',
  description:
    'Available to anyone with a property-scoped relationship to the space — no route-level capability gate.',
  security: SECURITY_CUSTOMER,
  request: {
    body: { content: { 'application/json': { schema: createMaintenanceRequestSchema } } },
  },
  responses: {
    201: jsonContent(maintenanceRequestSchema, 'Created.'),
    401: commonErrors[401],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/maintenance-requests/{id}',
  operationId: 'getMaintenanceRequest',
  tags: [TAG],
  summary: 'Returns one maintenance request. Accepts either its public reference or internal id.',
  security: SECURITY_CUSTOMER,
  request: { params: requestIdParam },
  responses: {
    200: jsonContent(maintenanceRequestSchema, 'The request.'),
    401: commonErrors[401],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/maintenance-requests/{id}',
  operationId: 'updateMaintenanceRequest',
  tags: [TAG],
  summary: 'Updates a maintenance request’s details.',
  description: 'Requires `maintenance.manage` on this request’s property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: requestIdParam,
    body: { content: { 'application/json': { schema: updateMaintenanceRequestSchema } } },
  },
  responses: {
    200: jsonContent(maintenanceRequestSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/maintenance-requests/{id}/status',
  operationId: 'updateMaintenanceRequestStatus',
  tags: [TAG],
  summary: 'Transitions a maintenance request’s status.',
  description: 'Requires `maintenance.manage` on this request’s property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: requestIdParam,
    body: { content: { 'application/json': { schema: updateStatusSchema } } },
  },
  responses: {
    200: jsonContent(maintenanceRequestSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/maintenance-requests/{id}/attachments/presign',
  operationId: 'presignMaintenanceAttachments',
  tags: [TAG],
  summary: 'Requests presigned upload URLs for one or more photos.',
  description:
    'Step 1 of the upload flow: request a presigned URL → PUT the file directly to S3 → ' +
    'register the uploaded object (next endpoint).',
  security: SECURITY_CUSTOMER,
  request: {
    params: requestIdParam,
    body: { content: { 'application/json': { schema: presignAttachmentsSchema } } },
  },
  responses: {
    200: jsonContent(z.array(presignedUploadSchema), 'One presigned upload per requested file.'),
    401: commonErrors[401],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/maintenance-requests/{id}/attachments',
  operationId: 'registerMaintenanceAttachments',
  tags: [TAG],
  summary: 'Registers attachments after they have been uploaded directly to S3.',
  security: SECURITY_CUSTOMER,
  request: {
    params: requestIdParam,
    body: { content: { 'application/json': { schema: registerAttachmentsSchema } } },
  },
  responses: {
    201: jsonContent(z.array(attachmentSchema), 'Registered.'),
    401: commonErrors[401],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/maintenance-requests/{id}/attachments',
  operationId: 'listMaintenanceAttachments',
  tags: [TAG],
  summary: 'Lists a maintenance request’s photo attachments.',
  security: SECURITY_CUSTOMER,
  request: { params: requestIdParam },
  responses: {
    200: jsonContent(z.array(attachmentSchema), 'Attachments.'),
    401: commonErrors[401],
    404: commonErrors[404],
  },
});
