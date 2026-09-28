import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { fromParam } from '../../middlewares/resolvePropertyId.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { listActivityForProperty } from '../activity/activity.controller.js';
import {
  addPersonToProperty,
  assignExistingPerson,
  listPeopleForProperty,
} from '../people/people.controller.js';
import { createSpaceForProperty, listSpacesForProperty } from '../spaces/spaces.controller.js';
import {
  createProperty,
  getProperty,
  getPropertyInsights,
  listProperties,
  updateProperty,
} from './properties.controller.js';

export const propertiesRouter = Router();

propertiesRouter.use(authenticate);

// Portfolio scoping happens inside the service (PropertiesService.list) via
// AuthorizationService.getAccessiblePropertyIds — a user with no accessible
// properties simply gets an empty list, no separate route gate needed here.
propertiesRouter.get('/', asyncHandler(listProperties));
// Creating a brand-new property has no propertyId to scope against, so this
// is the coarse "does this user hold property.manage on ANY property"
// form of requireCapability (no resolvePropertyId) — OWNER/ADMIN always
// pass via AuthorizationService.can's own special case; a property-scoped
// manager passes only if their organisation has granted property.manage,
// and only once they already manage at least one existing property (a
// user with zero PropertyMemberships holds no capabilities to check).
propertiesRouter.post('/', requireCapability('property.manage'), asyncHandler(createProperty));
// No route-level capability gate: a resident/tenant may view their own
// property read-only (pre-existing behaviour), separate from the
// operational `property.view` capability — PropertiesService.getById
// resolves both and 404s if neither applies (never leaking that a
// different property exists, staff or resident alike).
propertiesRouter.get('/:id', asyncHandler(getProperty));
propertiesRouter.patch(
  '/:id',
  requireCapability('property.manage', fromParam('id')),
  asyncHandler(updateProperty),
);
propertiesRouter.get(
  '/:id/insights',
  requireCapability('analytics.view', fromParam('id')),
  asyncHandler(getPropertyInsights),
);

propertiesRouter.get(
  '/:propertyId/spaces',
  requireCapability('spaces.view', fromParam('propertyId')),
  asyncHandler(listSpacesForProperty),
);
propertiesRouter.post(
  '/:propertyId/spaces',
  requireCapability('spaces.manage', fromParam('propertyId')),
  asyncHandler(createSpaceForProperty),
);

propertiesRouter.get(
  '/:propertyId/memberships',
  requireCapability('people.view', fromParam('propertyId')),
  asyncHandler(listPeopleForProperty),
);
propertiesRouter.post(
  '/:propertyId/memberships',
  requireCapability('people.manage', fromParam('propertyId')),
  asyncHandler(addPersonToProperty),
);
propertiesRouter.post(
  '/:propertyId/memberships/assign',
  requireCapability('people.manage', fromParam('propertyId')),
  asyncHandler(assignExistingPerson),
);

propertiesRouter.get(
  '/:propertyId/activity',
  requireCapability('activity.view', fromParam('propertyId')),
  asyncHandler(listActivityForProperty),
);
