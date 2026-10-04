import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import { listBackofficeAudit } from './backoffice-audit.controller.js';

export const backofficeAuditRouter = Router();

backofficeAuditRouter.use(authenticatePlatform, requirePlatformCapability('audit.view'));
backofficeAuditRouter.get('/', asyncHandler(listBackofficeAudit));
