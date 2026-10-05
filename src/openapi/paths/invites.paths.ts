import { z } from 'zod';
import {
  acceptInviteSchema,
  inviteTokenParamSchema,
} from '../../modules/invites/invites.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { registry, SECURITY_CUSTOMER, SECURITY_PUBLIC } from '../registry.js';

const TAG = 'People';

const invitePreviewSchema = registry.register(
  'InvitePreview',
  z.object({
    email: z.string().email(),
    firstName: z.string(),
    lastName: z.string(),
    organisationName: z.string(),
    expired: z.boolean(),
    alreadyHasAccount: z.boolean(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/invites/{token}',
  operationId: 'getInvitePreview',
  tags: [TAG],
  summary: 'Public — previews an invite before activation (who it’s for, whether it’s expired).',
  description: 'Unauthenticated. Resolved purely from the high-entropy token in the URL.',
  security: SECURITY_PUBLIC,
  request: { params: inviteTokenParamSchema },
  responses: {
    200: jsonContent(invitePreviewSchema, 'Invite preview.'),
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/invites/{token}/accept',
  operationId: 'acceptInvite',
  tags: [TAG],
  summary: 'Public — activates an invite by setting a password, creating the account.',
  security: SECURITY_PUBLIC,
  request: {
    params: inviteTokenParamSchema,
    body: { content: { 'application/json': { schema: acceptInviteSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ accessToken: z.string() }), 'Account created and signed in.'),
    404: commonErrors[404],
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/invites/{token}/accept-existing',
  operationId: 'acceptInviteForExistingUser',
  tags: [TAG],
  summary: 'Links an invite to the caller’s already-signed-in account.',
  description:
    'Requires the caller to already be signed in as the account the invite’s email belongs to.',
  security: SECURITY_CUSTOMER,
  request: { params: inviteTokenParamSchema },
  responses: {
    200: jsonContent(z.object({ linked: z.literal(true) }), 'Linked.'),
    401: commonErrors[401],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});
