import { z } from 'zod';
import {
  pageQueryParams,
  commonErrors,
  jsonContent,
  paginatedSchema,
} from '../components/common.schemas.js';
import { propertyDetailSchema, propertySummarySchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Properties';
const TAG_ACTIVITY = 'Properties';

const propertyIdParam = registry.register('PropertyIdParam', z.object({ id: z.string() }));
const propertyIdPathParam = registry.register(
  'PropertyIdPathParam',
  z.object({ propertyId: z.string() }),
);

const createPropertySchema = registry.register(
  'CreatePropertyRequest',
  z.object({
    name: z.string().min(1).max(160),
    code: z.string().min(1).max(40),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().optional(),
    country: z.string().min(1),
    postalCode: z.string().optional(),
    propertyType: z.string().openapi({ example: 'RESIDENTIAL' }),
  }),
);

const updatePropertySchema = registry.register(
  'UpdatePropertyRequest',
  createPropertySchema.partial().extend({
    status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/properties',
  operationId: 'listProperties',
  tags: [TAG],
  summary: 'Lists properties accessible to the caller.',
  description:
    'Org staff (OWNER/ADMIN/MEMBER) see every property in the organisation; a property-scoped ' +
    'user sees only properties they hold a membership or capability on — resolved server-side, ' +
    'never a client-supplied filter.',
  security: SECURITY_CUSTOMER,
  request: { query: z.object({ ...pageQueryParams, search: z.string().optional() }) },
  responses: {
    200: jsonContent(
      paginatedSchema(propertySummarySchema, 'Properties'),
      'Accessible properties.',
    ),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties',
  operationId: 'createProperty',
  tags: [TAG],
  summary: 'Creates a new property in the caller’s organisation.',
  description: 'Requires `property.manage` on at least one existing property (or OWNER/ADMIN).',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createPropertySchema } } } },
  responses: {
    201: jsonContent(propertyDetailSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/properties/{id}',
  operationId: 'getProperty',
  tags: [TAG],
  summary: 'Returns one property. Accepts either its public reference or internal id.',
  description:
    'A resident/tenant may view their own property read-only even without `property.view` ' +
    '— both paths resolve to the same 404-on-no-access behaviour for anyone else.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdParam },
  responses: {
    200: jsonContent(propertyDetailSchema, 'The property.'),
    401: commonErrors[401],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/properties/{id}',
  operationId: 'updateProperty',
  tags: [TAG],
  summary: 'Updates a property’s details.',
  description: 'Requires `property.manage` on this specific property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdParam,
    body: { content: { 'application/json': { schema: updatePropertySchema } } },
  },
  responses: {
    200: jsonContent(propertyDetailSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/properties/{id}/insights',
  operationId: 'getPropertyInsights',
  tags: [TAG],
  summary: 'Returns aggregate operational insights for a property (dashboard-style metrics).',
  description: 'Requires `analytics.view` on this property.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdParam },
  responses: {
    200: jsonContent(
      z.record(z.string(), z.unknown()),
      'Aggregate metrics; shape evolves with the dashboard.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/properties/{propertyId}/activity',
  operationId: 'listActivityForProperty',
  tags: [TAG_ACTIVITY],
  summary: 'Lists the activity/history feed for a property.',
  description: 'Requires `activity.view` on this property.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdPathParam, query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(
      paginatedSchema(
        z.object({
          id: z.string(),
          entityType: z.string(),
          entityId: z.string(),
          action: z.string(),
          createdAt: z.string().datetime(),
        }),
        'ActivityEvents',
      ),
      'Activity feed, newest first.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

export { propertyIdPathParam };
