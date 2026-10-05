import { z } from 'zod';
import {
  communicationsQuerySchema,
  createCommunicationSchema,
  previewAudienceSchema,
  sendCommunicationSchema,
  updateCommunicationSchema,
} from '../../modules/communications/communications.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import {
  communicationDeliverySchema,
  communicationSchema,
} from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Communications';

const communicationIdParam = registry.register(
  'CommunicationIdParam',
  z.object({ id: z.string() }),
);

registry.registerPath({
  method: 'get',
  path: '/communications',
  operationId: 'listCommunications',
  tags: [TAG],
  summary: 'Lists manager-authored communications.',
  description:
    'Requires `communications.view`. Never resident-visible — residents only see sent results via their own notifications.',
  security: SECURITY_CUSTOMER,
  request: { query: communicationsQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(communicationSchema, 'Communications'), 'Communications.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/communications',
  operationId: 'createCommunication',
  tags: [TAG],
  summary: 'Drafts a new communication.',
  description:
    'Requires `communications.manage`. Does not send — see POST /communications/{id}/send.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: createCommunicationSchema } } } },
  responses: {
    201: jsonContent(communicationSchema, 'Draft created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/communications/preview-audience',
  operationId: 'previewCommunicationAudience',
  tags: [TAG],
  summary: 'Previews how many recipients an audience rule would currently resolve to.',
  description:
    'Requires `communications.manage`. Read-only — the real resolution happens again at send time.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: previewAudienceSchema } } } },
  responses: {
    200: jsonContent(z.object({ recipientCount: z.number().int() }), 'Preview.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/communications/{id}',
  operationId: 'getCommunication',
  tags: [TAG],
  summary: 'Returns one communication.',
  description: 'Requires `communications.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: communicationIdParam },
  responses: {
    200: jsonContent(communicationSchema, 'The communication.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/communications/{id}',
  operationId: 'updateCommunication',
  tags: [TAG],
  summary: 'Updates a draft communication.',
  description: 'Requires `communications.manage`. Only a DRAFT may be edited.',
  security: SECURITY_CUSTOMER,
  request: {
    params: communicationIdParam,
    body: { content: { 'application/json': { schema: updateCommunicationSchema } } },
  },
  responses: {
    200: jsonContent(communicationSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/communications/{id}/send',
  operationId: 'sendCommunication',
  tags: [TAG],
  summary: 'Sends (or schedules) a communication.',
  description:
    'Requires `communications.send` — a narrower capability than `.manage`. Fan-out always ' +
    'happens asynchronously via the delivery worker, never inline on this request.',
  security: SECURITY_CUSTOMER,
  request: {
    params: communicationIdParam,
    body: { content: { 'application/json': { schema: sendCommunicationSchema } } },
  },
  responses: {
    200: jsonContent(communicationSchema, 'Sending or scheduled.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/communications/{id}/cancel',
  operationId: 'cancelCommunication',
  tags: [TAG],
  summary: 'Cancels a scheduled (not yet sent) communication.',
  description: 'Requires `communications.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: communicationIdParam },
  responses: {
    200: jsonContent(communicationSchema, 'Cancelled.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/communications/{id}/duplicate',
  operationId: 'duplicateCommunication',
  tags: [TAG],
  summary: 'Duplicates a communication as a new draft.',
  description: 'Requires `communications.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: communicationIdParam },
  responses: {
    201: jsonContent(communicationSchema, 'New draft created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/communications/{id}/delivery',
  operationId: 'getCommunicationDelivery',
  tags: [TAG],
  summary: 'Returns per-channel delivery status for a sent communication.',
  description: 'Requires `communications.view`.',
  security: SECURITY_CUSTOMER,
  request: { params: communicationIdParam },
  responses: {
    200: jsonContent(communicationDeliverySchema, 'Delivery status.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});
