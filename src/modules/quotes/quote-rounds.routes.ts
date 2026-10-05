import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import {
  fromMaintenanceRequestParam,
  fromQuoteParam,
  fromQuoteRoundParam,
} from '../../middlewares/resolvePropertyId.js';
import {
  resolveMaintenanceRequestReference,
  resolveQuoteRoundReference,
} from '../../middlewares/resolvePublicReference.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  awardQuoteRound,
  cancelQuoteRound,
  createQuoteRound,
  getEligibleContractorsForRequest,
  getQuoteRound,
  getQuoteRoundByMaintenanceRequest,
  inviteContractors,
  listQuoteAttachments,
  presignQuoteAttachment,
  registerQuoteAttachment,
} from './quote-rounds.controller.js';

export const quoteRoundsRouter = Router();

const prisma = getPrismaClient();

quoteRoundsRouter.use(authenticate);

quoteRoundsRouter.post(
  '/',
  requireCapability('quotes.manage', async (req) => {
    const maintenanceRequestId = req.body?.maintenanceRequestId as string | undefined;
    if (!maintenanceRequestId || !req.auth) return undefined;
    const request = await prisma.maintenanceRequest.findFirst({
      where: { id: maintenanceRequestId, organisationId: req.auth.organisationId },
      select: { propertyId: true },
    });
    return request?.propertyId;
  }),
  asyncHandler(createQuoteRound),
);
quoteRoundsRouter.get(
  '/by-request/:maintenanceRequestId',
  resolveMaintenanceRequestReference('maintenanceRequestId'),
  requireCapability('quotes.view', fromMaintenanceRequestParam('maintenanceRequestId')),
  asyncHandler(getQuoteRoundByMaintenanceRequest),
);
quoteRoundsRouter.get(
  '/by-request/:maintenanceRequestId/eligible-contractors',
  resolveMaintenanceRequestReference('maintenanceRequestId'),
  requireCapability('quotes.manage', fromMaintenanceRequestParam('maintenanceRequestId')),
  asyncHandler(getEligibleContractorsForRequest),
);
quoteRoundsRouter.get(
  '/:id',
  resolveQuoteRoundReference('id'),
  requireCapability('quotes.view', fromQuoteRoundParam('id')),
  asyncHandler(getQuoteRound),
);
quoteRoundsRouter.post(
  '/:id/invitations',
  resolveQuoteRoundReference('id'),
  requireCapability('quotes.manage', fromQuoteRoundParam('id')),
  asyncHandler(inviteContractors),
);
quoteRoundsRouter.post(
  '/:id/award',
  resolveQuoteRoundReference('id'),
  requireCapability('quotes.approve', fromQuoteRoundParam('id')),
  asyncHandler(awardQuoteRound),
);
quoteRoundsRouter.post(
  '/:id/cancel',
  resolveQuoteRoundReference('id'),
  requireCapability('quotes.manage', fromQuoteRoundParam('id')),
  asyncHandler(cancelQuoteRound),
);

// Quote document attachments — keyed by quoteId, not roundId, so these
// live under the same resolver quotesRouter already uses.
quoteRoundsRouter.post(
  '/quotes/:id/attachments/presign',
  requireCapability('quotes.manage', fromQuoteParam('id')),
  asyncHandler(presignQuoteAttachment),
);
quoteRoundsRouter.post(
  '/quotes/:id/attachments',
  requireCapability('quotes.manage', fromQuoteParam('id')),
  asyncHandler(registerQuoteAttachment),
);
quoteRoundsRouter.get(
  '/quotes/:id/attachments',
  requireCapability('quotes.view', fromQuoteParam('id')),
  asyncHandler(listQuoteAttachments),
);
