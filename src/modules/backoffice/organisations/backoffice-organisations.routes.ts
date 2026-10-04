import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  getBackofficeOrganisation,
  listBackofficeOrganisations,
  updateBackofficeOrganisation,
} from './backoffice-organisations.controller.js';

export const backofficeOrganisationsRouter = Router();

backofficeOrganisationsRouter.use(authenticatePlatform);
backofficeOrganisationsRouter.get(
  '/',
  requirePlatformCapability('organisations.view'),
  asyncHandler(listBackofficeOrganisations),
);
backofficeOrganisationsRouter.get(
  '/:id',
  requirePlatformCapability('organisations.view'),
  asyncHandler(getBackofficeOrganisation),
);
backofficeOrganisationsRouter.patch(
  '/:id',
  requirePlatformCapability('organisations.manage'),
  asyncHandler(updateBackofficeOrganisation),
);
