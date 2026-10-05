import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import {
  fromMaintenanceRequestParam,
  fromWorkOrderParam,
} from '../../middlewares/resolvePropertyId.js';
import {
  resolveMaintenanceRequestReference,
  resolveWorkOrderReference,
} from '../../middlewares/resolvePublicReference.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  assignWorkOrderContractor,
  createWorkOrder,
  getWorkOrder,
  getWorkOrderByMaintenanceRequest,
  getWorkOrderContractorEligibility,
  listWorkOrders,
  updateWorkOrderCost,
  updateWorkOrderStatus,
} from './work-orders.controller.js';

export const workOrdersRouter = Router();

const prisma = getPrismaClient();

// Work orders carry cost/contractor data — never resident-visible. Scoping
// beyond that (org staff full visibility vs. a property-scoped manager's
// assigned properties) happens inside the service for list/get; single
// writes are gated per-route below via the work order's own propertyId.
workOrdersRouter.use(authenticate);

workOrdersRouter.get('/', requireCapability('work_orders.view'), asyncHandler(listWorkOrders));
workOrdersRouter.post(
  '/',
  requireCapability('work_orders.manage', async (req) => {
    const maintenanceRequestId = req.body?.maintenanceRequestId as string | undefined;
    if (!maintenanceRequestId || !req.auth) return undefined;
    const request = await prisma.maintenanceRequest.findFirst({
      where: { id: maintenanceRequestId, organisationId: req.auth.organisationId },
      select: { propertyId: true },
    });
    return request?.propertyId;
  }),
  asyncHandler(createWorkOrder),
);
workOrdersRouter.get(
  '/by-request/:maintenanceRequestId',
  resolveMaintenanceRequestReference('maintenanceRequestId'),
  requireCapability('work_orders.view', fromMaintenanceRequestParam('maintenanceRequestId')),
  asyncHandler(getWorkOrderByMaintenanceRequest),
);
workOrdersRouter.get(
  '/:id',
  resolveWorkOrderReference('id'),
  requireCapability('work_orders.view', fromWorkOrderParam('id')),
  asyncHandler(getWorkOrder),
);
workOrdersRouter.patch(
  '/:id/status',
  resolveWorkOrderReference('id'),
  requireCapability('work_orders.manage', fromWorkOrderParam('id')),
  asyncHandler(updateWorkOrderStatus),
);
workOrdersRouter.get(
  '/:id/contractor-eligibility',
  resolveWorkOrderReference('id'),
  requireCapability('work_orders.manage', fromWorkOrderParam('id')),
  asyncHandler(getWorkOrderContractorEligibility),
);
workOrdersRouter.patch(
  '/:id/contractor',
  resolveWorkOrderReference('id'),
  requireCapability('work_orders.manage', fromWorkOrderParam('id')),
  asyncHandler(assignWorkOrderContractor),
);
workOrdersRouter.patch(
  '/:id/cost',
  resolveWorkOrderReference('id'),
  requireCapability('work_orders.manage', fromWorkOrderParam('id')),
  asyncHandler(updateWorkOrderCost),
);
