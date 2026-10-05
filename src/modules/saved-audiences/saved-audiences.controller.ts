import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { SavedAudiencesService } from './saved-audiences.service.js';
import { createSavedAudienceSchema, updateSavedAudienceSchema } from './saved-audiences.schemas.js';

const savedAudiencesService = new SavedAudiencesService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export async function listSavedAudiences(req: Request, res: Response) {
  const auth = requireAuth(req);
  const items = await savedAudiencesService.list(auth.organisationId, auth);
  res.json({ items });
}

export async function createSavedAudience(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = createSavedAudienceSchema.parse(req.body);
  const audience = await savedAudiencesService.create(
    auth.organisationId,
    auth,
    auth.userId,
    input,
  );
  res.status(201).json(audience);
}

export async function updateSavedAudience(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = updateSavedAudienceSchema.parse(req.body);
  const audience = await savedAudiencesService.update(
    auth.organisationId,
    auth,
    req.params.id as string,
    input,
  );
  res.json(audience);
}

export async function deleteSavedAudience(req: Request, res: Response) {
  const auth = requireAuth(req);
  await savedAudiencesService.delete(auth.organisationId, auth, req.params.id as string);
  res.status(204).send();
}
