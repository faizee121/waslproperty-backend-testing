import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  grantBackofficePlatformAccess,
  listBackofficePlatformUsers,
  resetBackofficePlatformUserPassword,
  updateBackofficePlatformUser,
} from './backoffice-platform-users.controller.js';

export const backofficePlatformUsersRouter = Router();

backofficePlatformUsersRouter.use(
  authenticatePlatform,
  requirePlatformCapability('platformUsers.manage'),
);
backofficePlatformUsersRouter.get('/', asyncHandler(listBackofficePlatformUsers));
backofficePlatformUsersRouter.post('/', asyncHandler(grantBackofficePlatformAccess));
backofficePlatformUsersRouter.patch('/:id', asyncHandler(updateBackofficePlatformUser));
backofficePlatformUsersRouter.post(
  '/:id/reset-password',
  asyncHandler(resetBackofficePlatformUserPassword),
);
