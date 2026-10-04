import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import { searchBackoffice } from './backoffice-search.controller.js';

export const backofficeSearchRouter = Router();

backofficeSearchRouter.use(
  authenticatePlatform,
  requirePlatformCapability('platform.dashboard.view'),
);
backofficeSearchRouter.get('/', asyncHandler(searchBackoffice));
