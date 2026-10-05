import {
  bulkSetLotsSchema,
  classifySpacesSchema,
  enableStrataSchema,
  updateStrataPlanSchema,
} from '../../modules/strata/strata.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { strataSummarySchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';
import { propertyIdPathParam } from './properties.paths.js';

const TAG = 'Strata';

registry.registerPath({
  method: 'get',
  path: '/properties/{propertyId}/strata',
  operationId: 'getStrataSummary',
  tags: [TAG],
  summary:
    'Returns a property’s strata setup status, plan details, and Units of Entitlement reconciliation.',
  description:
    'Requires `strata.view` on this property — a narrower capability than `property.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdPathParam },
  responses: {
    200: jsonContent(strataSummarySchema, 'Strata summary.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties/{propertyId}/strata/enable',
  operationId: 'enableStrata',
  tags: [TAG],
  summary: 'Starts the guided "Enable Strata Management" setup flow on a property.',
  description:
    'Moves strataStatus from NOT_ENABLED to SETUP_IN_PROGRESS. Requires `strata.manage` and the ' +
    'organisation’s STRATA_MANAGEMENT feature (jurisdiction-gated — see ADR-004).',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: enableStrataSchema } } },
  },
  responses: {
    200: jsonContent(strataSummarySchema, 'Setup started.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/properties/{propertyId}/strata/plan',
  operationId: 'updateStrataPlan',
  tags: [TAG],
  summary: 'Updates the strata plan number, scheme name, or declared Units of Entitlement.',
  description: 'Requires `strata.manage`. Fields may be explicitly cleared once already set.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: updateStrataPlanSchema } } },
  },
  responses: {
    200: jsonContent(strataSummarySchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'put',
  path: '/properties/{propertyId}/strata/lots',
  operationId: 'bulkSetStrataLots',
  tags: [TAG],
  summary: 'Bulk-creates or updates the property’s strata lots and their Units of Entitlement.',
  description:
    'Each entry either reuses an existing Space (`kind: "existing"`) or creates a brand-new one ' +
    '(`kind: "new"`). Requires `strata.manage`. See ADR-005 — Units of Entitlement Belong to the Lot.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: bulkSetLotsSchema } } },
  },
  responses: {
    200: jsonContent(strataSummarySchema, 'Lots saved.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'put',
  path: '/properties/{propertyId}/strata/spaces/classify',
  operationId: 'classifyStrataSpaces',
  tags: [TAG],
  summary: 'Explicitly classifies existing spaces as a Lot (with UOE) or Common Property.',
  description:
    'Never infers classification from a space’s name — every space is addressed by id and ' +
    'classified explicitly. Requires `strata.manage`.',
  security: SECURITY_CUSTOMER,
  request: {
    params: propertyIdPathParam,
    body: { content: { 'application/json': { schema: classifySpacesSchema } } },
  },
  responses: {
    200: jsonContent(strataSummarySchema, 'Classified.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/properties/{propertyId}/strata/complete',
  operationId: 'completeStrataSetup',
  tags: [TAG],
  summary: 'Completes guided strata setup, moving strataStatus to ACTIVE.',
  description:
    'Requires the declared Units of Entitlement total to reconcile exactly against the sum of ' +
    'lot entitlements (or an explicit override — see StrataService). Requires `strata.manage`.',
  security: SECURITY_CUSTOMER,
  request: { params: propertyIdPathParam },
  responses: {
    200: jsonContent(strataSummarySchema, 'Strata setup is now ACTIVE.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    409: commonErrors[409],
  },
});
