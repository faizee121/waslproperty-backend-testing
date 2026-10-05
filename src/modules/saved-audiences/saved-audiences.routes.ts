import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  createSavedAudience,
  deleteSavedAudience,
  listSavedAudiences,
  updateSavedAudience,
} from './saved-audiences.controller.js';

export const savedAudiencesRouter = Router();

savedAudiencesRouter.use(authenticate);

// Coarse route-level gate; the service does the real per-audience scoping
// (never an ORGANISATION-scope rule, never another property's — see
// assertAudienceWithinScope in communications.audience.ts, shared with
// CommunicationsService since a saved audience is just a reusable
// AudienceCriteria).
savedAudiencesRouter.get(
  '/',
  requireCapability('communications.view'),
  asyncHandler(listSavedAudiences),
);
savedAudiencesRouter.post(
  '/',
  requireCapability('communications.manage'),
  asyncHandler(createSavedAudience),
);
savedAudiencesRouter.patch(
  '/:id',
  requireCapability('communications.manage'),
  asyncHandler(updateSavedAudience),
);
savedAudiencesRouter.delete(
  '/:id',
  requireCapability('communications.manage'),
  asyncHandler(deleteSavedAudience),
);
