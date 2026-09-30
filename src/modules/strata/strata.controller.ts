import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { StrataService } from './strata.service.js';
import {
  bulkSetLotsSchema,
  classifySpacesSchema,
  enableStrataSchema,
  updateStrataPlanSchema,
} from './strata.schemas.js';

const strataService = new StrataService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export async function getStrataSummary(req: Request, res: Response) {
  const auth = requireAuth(req);
  const summary = await strataService.getSummary(auth.organisationId, req.params.propertyId as string);
  res.json(summary);
}

export async function enableStrata(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = enableStrataSchema.parse(req.body);
  const property = await strataService.enable(
    auth.organisationId,
    auth.userId,
    req.params.propertyId as string,
    input,
  );
  res.json(property);
}

export async function updateStrataPlan(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = updateStrataPlanSchema.parse(req.body);
  const property = await strataService.updatePlan(
    auth.organisationId,
    auth.userId,
    req.params.propertyId as string,
    input,
  );
  res.json(property);
}

export async function bulkSetStrataLots(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = bulkSetLotsSchema.parse(req.body);
  const summary = await strataService.bulkSetLots(
    auth.organisationId,
    auth.userId,
    req.params.propertyId as string,
    input,
  );
  res.json(summary);
}

export async function classifyStrataSpaces(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = classifySpacesSchema.parse(req.body);
  const summary = await strataService.classifySpaces(
    auth.organisationId,
    auth.userId,
    req.params.propertyId as string,
    input,
  );
  res.json(summary);
}

export async function completeStrataSetup(req: Request, res: Response) {
  const auth = requireAuth(req);
  const property = await strataService.completeSetup(
    auth.organisationId,
    auth.userId,
    req.params.propertyId as string,
  );
  res.json(property);
}
