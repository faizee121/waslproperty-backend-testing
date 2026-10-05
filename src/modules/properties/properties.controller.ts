import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { paginationQuerySchema } from '../../lib/pagination.js';
import { PropertiesService } from './properties.service.js';
import { createPropertySchema, updatePropertySchema } from './properties.schemas.js';

const propertiesService = new PropertiesService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export async function listProperties(req: Request, res: Response) {
  const auth = requireAuth(req);
  const query = paginationQuerySchema.parse(req.query);
  const result = await propertiesService.list(auth.organisationId, auth, query);
  res.json(result);
}

export async function createProperty(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = createPropertySchema.parse(req.body);
  const property = await propertiesService.create(auth.organisationId, auth.userId, input);
  res.status(201).json(property);
}

export async function getProperty(req: Request, res: Response) {
  const auth = requireAuth(req);
  const property = await propertiesService.getById(
    auth.organisationId,
    auth,
    req.params.id as string,
  );
  res.json(property);
}

export async function getPropertyInsights(req: Request, res: Response) {
  const auth = requireAuth(req);
  const insights = await propertiesService.getInsights(
    auth.organisationId,
    req.params.id as string,
    new Date(),
  );
  res.json(insights);
}

export async function updateProperty(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = updatePropertySchema.parse(req.body);
  const property = await propertiesService.update(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
    input,
  );
  res.json(property);
}
