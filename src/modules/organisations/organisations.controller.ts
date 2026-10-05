import type { Request, Response } from 'express';
import { NotFoundError, UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { resolveOrganisationFeatures } from './organisation-features.js';
import { updateOrganisationSchema } from './organisations.schemas.js';

const prisma = getPrismaClient();
const authorizationService = new AuthorizationService(prisma);

export async function getCurrentOrganisation(req: Request, res: Response) {
  if (!req.auth) {
    throw new UnauthorizedError();
  }

  const organisation = await prisma.organisation.findUnique({
    where: { id: req.auth.organisationId },
  });
  if (!organisation) {
    throw new NotFoundError('Organisation not found');
  }

  // The union of every capability this user holds anywhere in the
  // organisation — additive to accountType/orgRole, purely for
  // capability-driven frontend navigation. Never itself an authorization
  // decision: every request is still independently checked server-side.
  const capabilities = await authorizationService.getEffectiveCapabilitySummary(req.auth);

  res.json({
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    status: organisation.status,
    currencyCode: organisation.currencyCode,
    countryCode: organisation.countryCode,
    features: resolveOrganisationFeatures(organisation.countryCode),
    aiEnabled: organisation.aiEnabled,
    orgRole: req.auth.orgRole,
    accountType: req.auth.orgRole ? 'staff' : 'resident',
    propertyContactId: req.auth.propertyContactId ?? null,
    capabilities,
  });
}

/** OWNER/ADMIN only (see organisations.routes.ts).
 * - currencyCode: only affects the default new financial records are
 *   created with going forward; never mutates an existing WorkOrder/
 *   ContractorQuote's own currencyCode.
 * - countryCode: determines the organisation's resolved feature set (see
 *   organisation-features.ts). Independent of currencyCode — changing one
 *   never changes the other. */
export async function updateOrganisation(req: Request, res: Response) {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  const input = updateOrganisationSchema.parse(req.body);

  const organisation = await prisma.organisation.update({
    where: { id: req.auth.organisationId },
    data: {
      ...(input.currencyCode !== undefined && { currencyCode: input.currencyCode }),
      ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
      ...(input.aiEnabled !== undefined && { aiEnabled: input.aiEnabled }),
    },
  });

  res.json({
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    status: organisation.status,
    currencyCode: organisation.currencyCode,
    countryCode: organisation.countryCode,
    features: resolveOrganisationFeatures(organisation.countryCode),
    aiEnabled: organisation.aiEnabled,
  });
}
