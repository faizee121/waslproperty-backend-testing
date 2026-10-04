import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  listBackofficeMemberships,
  listBackofficeProperties,
  listBackofficeSpaces,
} from './backoffice-property-data.controller.js';

export const backofficePropertyDataRouter = Router();

backofficePropertyDataRouter.use(
  authenticatePlatform,
  requirePlatformCapability('properties.view'),
);
backofficePropertyDataRouter.get('/properties', asyncHandler(listBackofficeProperties));
backofficePropertyDataRouter.get('/spaces', asyncHandler(listBackofficeSpaces));
backofficePropertyDataRouter.get('/memberships', asyncHandler(listBackofficeMemberships));
