import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { presignGet } from '../../lib/s3.js';
import { PropertyDocumentsService } from './property-documents.service.js';
import {
  presignPropertyDocumentSchema,
  registerPropertyDocumentSchema,
  updateDraftSchema,
} from './property-documents.schemas.js';

const service = new PropertyDocumentsService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export async function presignPropertyDocument(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = presignPropertyDocumentSchema.parse(req.body);
  const result = await service.presign(auth.organisationId, input);
  res.json(result);
}

export async function registerPropertyDocument(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = registerPropertyDocumentSchema.parse(req.body);
  const document = await service.register(auth.organisationId, auth, input);
  res.status(201).json(document);
}

export async function getPropertyDocument(req: Request, res: Response) {
  const auth = requireAuth(req);
  const result = await service.getById(auth.organisationId, req.params.id as string);
  res.json(result);
}

export async function getPropertyDocumentSourceUrl(req: Request, res: Response) {
  const auth = requireAuth(req);
  const { document } = await service.getById(auth.organisationId, req.params.id as string);
  const url = await presignGet(document.storageKey);
  res.json({ url });
}

export async function updatePropertyDocumentDraft(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = updateDraftSchema.parse(req.body);
  const result = await service.updateDraft(auth.organisationId, req.params.id as string, input);
  res.json(result);
}

export async function retryPropertyDocumentAnalysis(req: Request, res: Response) {
  const auth = requireAuth(req);
  const document = await service.retry(auth.organisationId, auth, req.params.id as string);
  res.json(document);
}

export async function confirmPropertyDocument(req: Request, res: Response) {
  const auth = requireAuth(req);
  const property = await service.confirm(auth.organisationId, auth, req.params.id as string);
  res.status(201).json(property);
}
