import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  getBackofficeCommunicationDeliveries,
  listBackofficeCommunications,
} from './backoffice-communications.controller.js';

export const backofficeCommunicationsRouter = Router();

backofficeCommunicationsRouter.use(
  authenticatePlatform,
  requirePlatformCapability('communications.view'),
);
backofficeCommunicationsRouter.get('/', asyncHandler(listBackofficeCommunications));
backofficeCommunicationsRouter.get(
  '/:id/deliveries',
  asyncHandler(getBackofficeCommunicationDeliveries),
);
