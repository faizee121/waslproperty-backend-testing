import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { fromSpaceParam } from '../../middlewares/resolvePropertyId.js';
import { resolveSpaceReference } from '../../middlewares/resolvePublicReference.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { listActivityForSpace } from '../activity/activity.controller.js';
import { listPeopleForSpace } from '../people/people.controller.js';
import { getSpace, updateSpace } from './spaces.controller.js';

export const spacesRouter = Router();

spacesRouter.use(authenticate);

spacesRouter.get(
  '/:id',
  resolveSpaceReference('id'),
  requireCapability('spaces.view', fromSpaceParam('id')),
  asyncHandler(getSpace),
);
spacesRouter.patch(
  '/:id',
  resolveSpaceReference('id'),
  requireCapability('spaces.manage', fromSpaceParam('id')),
  asyncHandler(updateSpace),
);
spacesRouter.get(
  '/:id/memberships',
  resolveSpaceReference('id'),
  requireCapability('people.view', fromSpaceParam('id')),
  asyncHandler(listPeopleForSpace),
);
spacesRouter.get(
  '/:id/activity',
  resolveSpaceReference('id'),
  requireCapability('activity.view', fromSpaceParam('id')),
  asyncHandler(listActivityForSpace),
);
