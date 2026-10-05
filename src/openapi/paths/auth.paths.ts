import { z } from 'zod';
import { loginSchema, registerSchema } from '../../modules/auth/auth.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { organisationSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_PUBLIC } from '../registry.js';

const TAG = 'Authentication';

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
});

const authResultSchema = registry.register(
  'AuthResult',
  z.object({
    user: userSchema,
    organisation: organisationSchema,
    orgRole: z.enum(['OWNER', 'ADMIN', 'MEMBER']).nullable(),
    accountType: z.enum(['staff', 'resident']),
    accessToken: z.string().openapi({
      description: 'Send as `Authorization: Bearer <accessToken>` on every subsequent request.',
    }),
  }),
);

const chooseOrganisationSchema = registry.register(
  'ChooseOrganisationResponse',
  z.object({
    requiresOrganisationSelection: z.literal(true),
    organisations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        accountType: z.enum(['staff', 'resident']),
        orgRole: z.enum(['OWNER', 'ADMIN', 'MEMBER']).nullable(),
        propertyRoles: z.array(z.string()),
      }),
    ),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/auth/register',
  operationId: 'register',
  tags: [TAG],
  summary: 'Registers a new organisation and its first (OWNER) user.',
  description:
    'Creates a brand-new Organisation and a User with the OWNER role. Sets the refresh-token ' +
    'cookie and returns an access token — the caller is signed in immediately, no separate ' +
    'login step.',
  security: SECURITY_PUBLIC,
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: {
    201: jsonContent(authResultSchema, 'Organisation and user created; signed in.'),
    409: commonErrors[409],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  operationId: 'login',
  tags: [TAG],
  summary: 'Authenticates a user and starts a session.',
  description:
    'Returns an access token directly, unless the account has more than one organisation ' +
    'relationship (a staff membership and/or a resident contact in more than one organisation), ' +
    'in which case it returns a disambiguation list instead — the caller resubmits with the ' +
    'chosen `organisationId` (and `accountType`, if that alone is still ambiguous).',
  security: SECURITY_PUBLIC,
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: {
      description: 'Signed in, or a list of organisations to choose from.',
      content: {
        'application/json': {
          schema: z.union([authResultSchema, chooseOrganisationSchema]),
        },
      },
    },
    401: commonErrors[401],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/refresh',
  operationId: 'refresh',
  tags: [TAG],
  summary: 'Exchanges the refresh-token cookie for a new access token.',
  description:
    'Reads the httpOnly `refreshToken` cookie (never a request body or header) and returns a ' +
    'new access token, rotating the refresh cookie. Swagger UI cannot exercise this endpoint ' +
    'directly, since it never sends the cookie as a bearer token.',
  security: SECURITY_PUBLIC,
  responses: {
    200: jsonContent(z.object({ accessToken: z.string() }), 'New access token issued.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  operationId: 'logout',
  tags: [TAG],
  summary: 'Revokes the current refresh token and clears the session cookie.',
  security: SECURITY_PUBLIC,
  responses: { 204: { description: 'Signed out.' } },
});
