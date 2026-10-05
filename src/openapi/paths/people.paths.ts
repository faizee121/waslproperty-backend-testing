import { z } from 'zod';
import {
  addPersonSchema,
  assignExistingPersonSchema,
  peopleDirectoryQuerySchema,
  updateMembershipSchema,
} from '../../modules/people/people.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import { contactSummarySchema, membershipSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';
import { propertyIdPathParam } from './properties.paths.js';

const TAG = 'People';

const membershipIdParam = registry.register(
  'MembershipIdParam',
  z.object({ membershipId: z.string() }),
);
const contactIdParam = registry.register('ContactIdParam', z.object({ contactId: z.string() }));

registry.registerPath({
  method: 'get',
  path: '/people/me',
  operationId: 'listMyMemberships',
  tags: [TAG],
  summary:
    'Lists the authenticated caller’s own property/space memberships (resident/tenant view).',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.array(membershipSchema), 'Caller’s own memberships.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/people',
  operationId: 'listPeopleDirectory',
  tags: [TAG],
  summary: 'Lists people across properties the caller can access.',
  security: SECURITY_CUSTOMER,
  request: { query: peopleDirectoryQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(membershipSchema, 'People'), 'Accessible people.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/people/contacts/search',
  operationId: 'searchContacts',
  tags: [TAG],
  summary:
    'Searches the organisation’s contact directory by name/email, for attaching to a property.',
  description: 'Requires `people.manage` on at least one property.',
  security: SECURITY_CUSTOMER,
  request: { query: z.object({ search: z.string().min(1) }) },
  responses: {
    200: jsonContent(z.array(contactSummarySchema), 'Matching contacts.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/people/memberships/{membershipId}',
  operationId: 'updateMembership',
  tags: [TAG],
  summary: 'Updates a membership’s role or space assignment.',
  description: 'Requires `people.manage` on the membership’s property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: membershipIdParam,
    body: { content: { 'application/json': { schema: updateMembershipSchema } } },
  },
  responses: {
    200: jsonContent(membershipSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/people/memberships/{membershipId}/end',
  operationId: 'endMembership',
  tags: [TAG],
  summary: 'Ends a membership (move-out / offboarding).',
  description: 'Requires `people.manage` on the membership’s property.',
  security: SECURITY_CUSTOMER,
  request: { params: membershipIdParam },
  responses: {
    200: jsonContent(membershipSchema, 'Ended.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/people/{contactId}/invite',
  operationId: 'inviteContact',
  tags: [TAG],
  summary: 'Sends a portal-activation invite to a contact.',
  description: 'Requires `people.manage` on a property the contact has a membership on.',
  security: SECURITY_CUSTOMER,
  request: { params: contactIdParam },
  responses: {
    200: jsonContent(z.object({ invited: z.literal(true) }), 'Invite sent.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/people/{contactId}/invite/resend',
  operationId: 'resendContactInvite',
  tags: [TAG],
  summary: 'Resends a pending invite.',
  security: SECURITY_CUSTOMER,
  request: { params: contactIdParam },
  responses: {
    200: jsonContent(z.object({ invited: z.literal(true) }), 'Invite resent.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/people/{contactId}/invite/revoke',
  operationId: 'revokeContactInvite',
  tags: [TAG],
  summary: 'Revokes a pending invite.',
  security: SECURITY_CUSTOMER,
  request: { params: contactIdParam },
  responses: {
    200: jsonContent(z.object({ revoked: z.literal(true) }), 'Invite revoked.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Memberships nested under a property (properties.routes.ts) ---

registry.registerPath({
  method: 'get',
  path: '/properties/{propertyId}/memberships',
  operationId: 'listPeopleForProperty',
  tags: [TAG],
  summary: 'Lists people associated with a property.',
  description: 'Requires `people.view` on this property.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdPathParam },
  responses: {
    200: jsonContent(z.array(membershipSchema), 'Memberships on this property.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties/{propertyId}/memberships',
  operationId: 'addPersonToProperty',
  tags: [TAG],
  summary:
    'Adds a brand-new person to a property (creates their contact record and sends an invite).',
  description: 'Requires `people.manage` on this property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: addPersonSchema } } },
  },
  responses: {
    201: jsonContent(membershipSchema, 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties/{propertyId}/memberships/assign',
  operationId: 'assignExistingPerson',
  tags: [TAG],
  summary: 'Attaches an existing contact from the organisation directory to a property.',
  description: 'Requires `people.manage` on this property.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: assignExistingPersonSchema } } },
  },
  responses: {
    201: jsonContent(membershipSchema, 'Attached.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});
