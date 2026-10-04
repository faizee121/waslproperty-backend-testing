import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import { authenticatePlatform } from '../../../middlewares/auth.middleware.js';
import {
  changePlatformPassword,
  getBackofficeEnvironment,
  getCurrentPlatformUser,
  platformLogin,
  platformLogout,
  platformRefresh,
} from './platform-auth.controller.js';

export const platformAuthRouter = Router();

platformAuthRouter.get('/environment', asyncHandler(getBackofficeEnvironment));
platformAuthRouter.post('/login', asyncHandler(platformLogin));
platformAuthRouter.post('/refresh', asyncHandler(platformRefresh));
platformAuthRouter.post('/logout', asyncHandler(platformLogout));
platformAuthRouter.get('/me', authenticatePlatform, asyncHandler(getCurrentPlatformUser));
platformAuthRouter.post(
  '/change-password',
  authenticatePlatform,
  asyncHandler(changePlatformPassword),
);
