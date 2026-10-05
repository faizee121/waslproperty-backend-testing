import { z } from 'zod';
import {
  continueConversationSchema,
  startConversationSchema,
} from '../../modules/ai/ai.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import {
  aiConversationDetailSchema,
  aiConversationSummarySchema,
  aiResponseSchema,
  aiStatusSchema,
} from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Wasl AI';

const conversationIdParam = registry.register(
  'AiConversationIdParam',
  z.object({ id: z.string() }),
);

registry.registerPath({
  method: 'get',
  path: '/ai/status',
  operationId: 'getAiStatus',
  tags: [TAG],
  summary: 'Reports whether Wasl AI is available to the caller, and why not if it isn’t.',
  description:
    'Deliberately NOT gated behind `ai.use` — the frontend needs to explain WHY the entry ' +
    'point is hidden (platform disabled / organisation disabled / not authorised), not just see a 403.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(aiStatusSchema, 'Availability.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/ai/conversations',
  operationId: 'startAiConversation',
  tags: [TAG],
  summary: 'Starts a new Wasl AI conversation.',
  description:
    'Requires `ai.use` (and the platform + organisation kill switches to both be on — see ' +
    'ADR-007). Responses are advisory: authorization and domain validation always remain ' +
    'server-side; Wasl AI never bypasses RBAC, approval policy, or compliance checks.',
  security: SECURITY_CUSTOMER,
  request: { body: { content: { 'application/json': { schema: startConversationSchema } } } },
  responses: {
    201: jsonContent(
      z.object({ conversationId: z.string(), response: aiResponseSchema }),
      'Conversation started.',
    ),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
    429: commonErrors[429],
  },
});

registry.registerPath({
  method: 'get',
  path: '/ai/conversations',
  operationId: 'listAiConversations',
  tags: [TAG],
  summary: 'Lists the caller’s own Wasl AI conversations.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.object({ items: z.array(aiConversationSummarySchema) }), 'Conversations.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/ai/conversations/{id}',
  operationId: 'getAiConversation',
  tags: [TAG],
  summary: 'Returns one conversation with its full message history.',
  description: 'Only the owning user can read their own conversation.',
  security: SECURITY_CUSTOMER,
  request: { params: conversationIdParam },
  responses: {
    200: jsonContent(aiConversationDetailSchema, 'The conversation.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/ai/conversations/{id}/messages',
  operationId: 'continueAiConversation',
  tags: [TAG],
  summary: 'Sends a follow-up message in an existing conversation.',
  security: SECURITY_CUSTOMER,
  request: {
    params: conversationIdParam,
    body: { content: { 'application/json': { schema: continueConversationSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ response: aiResponseSchema }), 'Assistant response.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
    429: commonErrors[429],
  },
});
