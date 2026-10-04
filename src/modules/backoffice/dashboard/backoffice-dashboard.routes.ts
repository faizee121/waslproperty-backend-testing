import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import { getBackofficeDashboard } from './backoffice-dashboard.controller.js';

export const backofficeDashboardRouter = Router();

backofficeDashboardRouter.use(
  authenticatePlatform,
  requirePlatformCapability('platform.dashboard.view'),
);
backofficeDashboardRouter.get('/', asyncHandler(getBackofficeDashboard));
