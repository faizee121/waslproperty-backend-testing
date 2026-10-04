import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  getBackofficeJobsOverview,
  listBackofficeDeliveries,
  retryBackofficeDelivery,
} from './backoffice-jobs.controller.js';

export const backofficeJobsRouter = Router();

backofficeJobsRouter.use(authenticatePlatform, requirePlatformCapability('jobs.view'));
backofficeJobsRouter.get('/', asyncHandler(getBackofficeJobsOverview));
backofficeJobsRouter.get('/deliveries', asyncHandler(listBackofficeDeliveries));
backofficeJobsRouter.post(
  '/deliveries/:id/retry',
  requirePlatformCapability('jobs.retry'),
  asyncHandler(retryBackofficeDelivery),
);
