import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { resolveCommunicationReference } from '../../middlewares/resolvePublicReference.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  cancelCommunication,
  createCommunication,
  duplicateCommunication,
  getCommunication,
  getCommunicationDelivery,
  listCommunications,
  previewCommunicationAudience,
  sendCommunication,
  updateCommunication,
} from './communications.controller.js';

// Manager communications — never resident-visible (residents only ever see
// the *result* of a sent communication, via their own notifications inbox
// — never this router). Property scoping beyond the coarse capability
// check below happens inside CommunicationsService, which validates every
// audience (ORGANISATION/PROPERTY/SPACE scope) against the caller's
// accessible properties — see assertAudienceWithinScope.
export const communicationsRouter = Router();

communicationsRouter.use(authenticate);

communicationsRouter.get(
  '/',
  requireCapability('communications.view'),
  asyncHandler(listCommunications),
);
communicationsRouter.post(
  '/',
  requireCapability('communications.manage'),
  asyncHandler(createCommunication),
);
communicationsRouter.post(
  '/preview-audience',
  requireCapability('communications.manage'),
  asyncHandler(previewCommunicationAudience),
);
communicationsRouter.get(
  '/:id',
  resolveCommunicationReference('id'),
  requireCapability('communications.view'),
  asyncHandler(getCommunication),
);
communicationsRouter.patch(
  '/:id',
  resolveCommunicationReference('id'),
  requireCapability('communications.manage'),
  asyncHandler(updateCommunication),
);
communicationsRouter.post(
  '/:id/send',
  resolveCommunicationReference('id'),
  requireCapability('communications.send'),
  asyncHandler(sendCommunication),
);
communicationsRouter.post(
  '/:id/cancel',
  resolveCommunicationReference('id'),
  requireCapability('communications.manage'),
  asyncHandler(cancelCommunication),
);
communicationsRouter.post(
  '/:id/duplicate',
  resolveCommunicationReference('id'),
  requireCapability('communications.manage'),
  asyncHandler(duplicateCommunication),
);
communicationsRouter.get(
  '/:id/delivery',
  resolveCommunicationReference('id'),
  requireCapability('communications.view'),
  asyncHandler(getCommunicationDelivery),
);
