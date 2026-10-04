import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import { getBackofficeUser, listBackofficeUsers } from './backoffice-users.controller.js';

export const backofficeUsersRouter = Router();

backofficeUsersRouter.use(authenticatePlatform, requirePlatformCapability('users.view'));
backofficeUsersRouter.get('/', asyncHandler(listBackofficeUsers));
backofficeUsersRouter.get('/:id', asyncHandler(getBackofficeUser));
