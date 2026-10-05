import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  confirmPropertyDocument,
  getPropertyDocument,
  getPropertyDocumentSourceUrl,
  presignPropertyDocument,
  registerPropertyDocument,
  retryPropertyDocumentAnalysis,
  updatePropertyDocumentDraft,
} from './property-documents.controller.js';

export const propertyDocumentsRouter = Router();

/** Gated behind BOTH property.manage and strata.manage — not a new
 * capability of its own (M15 Section 37's explicit "do not create
 * capability explosion": this flow creates a property AND its strata
 * setup in one confirmed action, so it requires exactly the two
 * capabilities that would otherwise be needed to do both separately). No
 * resolvePropertyId — no Property exists yet for any of these routes. */
propertyDocumentsRouter.use(
  authenticate,
  requireCapability('property.manage'),
  requireCapability('strata.manage'),
);

propertyDocumentsRouter.post('/presign', asyncHandler(presignPropertyDocument));
propertyDocumentsRouter.post('/', asyncHandler(registerPropertyDocument));
propertyDocumentsRouter.get('/:id', asyncHandler(getPropertyDocument));
propertyDocumentsRouter.get('/:id/source-url', asyncHandler(getPropertyDocumentSourceUrl));
propertyDocumentsRouter.patch('/:id/draft', asyncHandler(updatePropertyDocumentDraft));
propertyDocumentsRouter.post('/:id/retry', asyncHandler(retryPropertyDocumentAnalysis));
propertyDocumentsRouter.post('/:id/confirm', asyncHandler(confirmPropertyDocument));
