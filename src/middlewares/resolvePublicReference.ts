import type { NextFunction, Request, Response } from 'express';
import { getPrismaClient } from '../lib/prisma.js';

const prisma = getPrismaClient();

/**
 * Rewrites req.params[paramName] from a customer-facing public reference
 * (e.g. "PROP-K7M4Q2") to the resource's real internal cuid, IN PLACE,
 * before any downstream authorization resolver (resolvePropertyId.ts) or
 * controller/service runs — so nothing downstream (requireCapability's
 * fromParam, every service's own findFirst, etc.) needs to know public
 * references exist at all; every existing lookup keeps working completely
 * unchanged because by the time it runs, the param already looks like a
 * normal id.
 *
 * A value that's already a real id simply resolves to itself (one extra
 * indexed lookup, never incorrect — see this file's test coverage for
 * "legacy cuid URL still resolves"). A value that matches neither an id
 * nor a publicReference in this organisation is left completely untouched,
 * so whatever existing findFirst({ id: <that value>, organisationId })
 * runs next finds nothing and 404s exactly as it always has — this
 * middleware adds no 404/403 of its own and no new trust: a public
 * reference is an identifier, never authorization (see
 * src/lib/public-reference.ts's doc comment).
 */
function resolver(
  findById: (value: string, organisationId: string) => Promise<{ id: string } | null>,
  paramName: string,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      if (!req.auth) return next();
      const raw = req.params[paramName];
      if (!raw) return next();
      const found = await findById(raw, req.auth.organisationId);
      if (found) req.params[paramName] = found.id;
      next();
    })().catch(next);
  };
}

export function resolvePropertyReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.property.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}

export function resolveSpaceReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.space.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}

export function resolveMaintenanceRequestReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.maintenanceRequest.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}

export function resolveWorkOrderReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.workOrder.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}

export function resolveQuoteRoundReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.quoteRound.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}

export function resolveCommunicationReference(paramName: string) {
  return resolver(
    (value, organisationId) =>
      prisma.communication.findFirst({
        where: { OR: [{ id: value }, { publicReference: value }], organisationId },
        select: { id: true },
      }),
    paramName,
  );
}
