import { z } from 'zod';
import {
  createSavedAudienceSchema,
  updateSavedAudienceSchema,
} from '../../modules/saved-audiences/saved-audiences.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { savedAudienceSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Communications';
const idParam = registry.register('SavedAudienceIdParam', z.object({ id: z.string() }));

registry.registerPath({
  method: 'get',
  path: '/saved-audiences',
  operationId: 'listSavedAudiences',
  tags: [TAG],
  summary: 'Lists reusable audience definitions for communications.',
  description: 'Requires `communications.view`.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.array(savedAudienceSchema), 'Saved audiences.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/saved-audiences',
  operationId: 'createSavedAudience',
  tags: [TAG],
  summary: 'Saves a reusable audience definition.',
  description: 'Requires `communications.manage`.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createSavedAudienceSchema } } } },
  responses: {
    201: jsonContent(savedAudienceSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/saved-audiences/{id}',
  operationId: 'updateSavedAudience',
  tags: [TAG],
  summary: 'Updates a saved audience.',
  description: 'Requires `communications.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: updateSavedAudienceSchema } } },
  },
  responses: {
    200: jsonContent(savedAudienceSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/saved-audiences/{id}',
  operationId: 'deleteSavedAudience',
  tags: [TAG],
  summary: 'Deletes a saved audience.',
  description: 'Requires `communications.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: idParam },
  responses: {
    204: { description: 'Deleted.' },
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});
