import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler.js';
import {
  authenticatePlatform,
  requirePlatformCapability,
} from '../../../middlewares/auth.middleware.js';
import {
  listBackofficeContractors,
  listBackofficeQuotes,
  listBackofficeRequests,
  listBackofficeWorkOrders,
} from './backoffice-operations.controller.js';

export const backofficeOperationsRouter = Router();

backofficeOperationsRouter.use(authenticatePlatform, requirePlatformCapability('operations.view'));
backofficeOperationsRouter.get('/requests', asyncHandler(listBackofficeRequests));
backofficeOperationsRouter.get('/work-orders', asyncHandler(listBackofficeWorkOrders));
backofficeOperationsRouter.get('/contractors', asyncHandler(listBackofficeContractors));
backofficeOperationsRouter.get('/quotes', asyncHandler(listBackofficeQuotes));
