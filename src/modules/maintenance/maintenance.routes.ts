import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { fromMaintenanceRequestParam } from '../../middlewares/resolvePropertyId.js';
import { resolveMaintenanceRequestReference } from '../../middlewares/resolvePublicReference.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  listMaintenanceAttachments,
  presignMaintenanceAttachments,
  registerMaintenanceAttachments,
} from './attachments.controller.js';
import {
  createMaintenanceRequest,
  getMaintenanceRequest,
  listMaintenanceRequests,
  updateMaintenanceRequest,
  updateMaintenanceRequestStatus,
} from './maintenance.controller.js';

export const maintenanceRouter = Router();

maintenanceRouter.use(authenticate);

// Scoping (org staff full visibility vs. a resident's own reports only vs.
// a property-scoped manager's assigned properties) happens inside
// MaintenanceService — see its list()/getById() for the full resolution.
maintenanceRouter.get('/', asyncHandler(listMaintenanceRequests));
maintenanceRouter.post('/', asyncHandler(createMaintenanceRequest));
maintenanceRouter.get(
  '/:id',
  resolveMaintenanceRequestReference('id'),
  asyncHandler(getMaintenanceRequest),
);
maintenanceRouter.patch(
  '/:id/status',
  resolveMaintenanceRequestReference('id'),
  requireCapability('maintenance.manage', fromMaintenanceRequestParam('id')),
  asyncHandler(updateMaintenanceRequestStatus),
);
maintenanceRouter.patch(
  '/:id',
  resolveMaintenanceRequestReference('id'),
  requireCapability('maintenance.manage', fromMaintenanceRequestParam('id')),
  asyncHandler(updateMaintenanceRequest),
);

maintenanceRouter.post(
  '/:id/attachments/presign',
  resolveMaintenanceRequestReference('id'),
  asyncHandler(presignMaintenanceAttachments),
);
maintenanceRouter.post(
  '/:id/attachments',
  resolveMaintenanceRequestReference('id'),
  asyncHandler(registerMaintenanceAttachments),
);
maintenanceRouter.get(
  '/:id/attachments',
  resolveMaintenanceRequestReference('id'),
  asyncHandler(listMaintenanceAttachments),
);
