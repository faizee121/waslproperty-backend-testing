import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import { getBackofficeIntegrations } from './backoffice-integrations.controller.js';

export const backofficeIntegrationsRouter = Router();

backofficeIntegrationsRouter.use(
  authenticatePlatform,
  requirePlatformCapability('integrations.view'),
);
backofficeIntegrationsRouter.get('/', asyncHandler(getBackofficeIntegrations));
