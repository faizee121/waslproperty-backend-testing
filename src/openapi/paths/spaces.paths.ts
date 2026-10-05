import { z } from 'zod';
import { createSpaceSchema, updateSpaceSchema } from '../../modules/spaces/spaces.schemas.js';
import {
  commonErrors,
  jsonContent,
  pageQueryParams,
  paginatedSchema,
} from '../components/common.schemas.js';
import { membershipSchema, spaceSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';
import { propertyIdPathParam } from './properties.paths.js';

const TAG = 'Lots & Areas';

const spaceIdParam = registry.register('SpaceIdParam', z.object({ id: z.string() }));

registry.registerPath({
  method: 'get',
  path: '/properties/{propertyId}/spaces',
  operationId: 'listSpacesForProperty',
  tags: [TAG],
  summary: 'Lists the spaces/lots belonging to a property.',
  description: 'Requires `spaces.view` on this property.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdPathParam, query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(spaceSchema, 'Spaces'), 'Spaces on this property.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties/{propertyId}/spaces',
  operationId: 'createSpaceForProperty',
  tags: [TAG],
  summary: 'Creates a new space/unit/lot on a property.',
  description: 'Requires `spaces.manage` on this property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: createSpaceSchema } } },
  },
  responses: {
    201: jsonContent(spaceSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/spaces/{id}',
  operationId: 'getSpace',
  tags: [TAG],
  summary: 'Returns one space. Accepts either its public reference or internal id.',
  description: 'Requires `spaces.view` on the space’s property.',
  security: SECURITY_CUSTOMER,
  request: { params: spaceIdParam },
  responses: {
    200: jsonContent(spaceSchema, 'The space.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/spaces/{id}',
  operationId: 'updateSpace',
  tags: [TAG],
  summary: 'Updates a space.',
  description: 'Requires `spaces.manage` on the space’s property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: spaceIdParam,
    body: { content: { 'application/json': { schema: updateSpaceSchema } } },
  },
  responses: {
    200: jsonContent(spaceSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/spaces/{id}/memberships',
  operationId: 'listPeopleForSpace',
  tags: [TAG],
  summary: 'Lists people (owners/tenants/residents) associated with a space.',
  description: 'Requires `people.view` on the space’s property.',
  security: SECURITY_CUSTOMER,
  request: { params: spaceIdParam },
  responses: {
    200: jsonContent(z.array(membershipSchema), 'Memberships on this space.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/spaces/{id}/activity',
  operationId: 'listActivityForSpace',
  tags: [TAG],
  summary: 'Lists the activity/history feed for a space.',
  description: 'Requires `activity.view` on the space’s property.',
  security: SECURITY_CUSTOMER,
  request: { params: spaceIdParam, query: z.object(pageQueryParams) },
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
        'SpaceActivityEvents',
      ),
      'Activity feed, newest first.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});
