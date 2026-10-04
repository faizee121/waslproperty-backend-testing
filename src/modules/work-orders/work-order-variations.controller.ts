import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { WorkOrderVariationsService } from './work-order-variations.service.js';
import {
  createVariationSchema,
  presignVariationAttachmentSchema,
  registerVariationAttachmentSchema,
  rejectVariationSchema,
  setVariationWorkflowModeSchema,
} from './work-order-variations.schemas.js';

const variationsService = new WorkOrderVariationsService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export async function listVariations(req: Request, res: Response) {
  const auth = requireAuth(req);
  const items = await variationsService.list(auth.organisationId, req.params.workOrderId as string);
  res.json({ items });
}

export async function getCommercialSummary(req: Request, res: Response) {
  const auth = requireAuth(req);
  const summary = await variationsService.getCommercialSummary(
    auth.organisationId,
    req.params.workOrderId as string,
  );
  res.json(summary);
}

export async function createVariation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = createVariationSchema.parse(req.body);
  const variation = await variationsService.create(
    auth.organisationId,
    auth.userId,
    req.params.workOrderId as string,
    input,
  );
  res.status(201).json(variation);
}

export async function setVariationWorkflowMode(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = setVariationWorkflowModeSchema.parse(req.body);
  const variation = await variationsService.setWorkflowMode(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
    input,
  );
  res.json(variation);
}

export async function approveVariation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const variation = await variationsService.approve(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
  );
  res.json(variation);
}

export async function rejectVariation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = rejectVariationSchema.parse(req.body);
  const variation = await variationsService.reject(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
    input,
  );
  res.json(variation);
}

export async function cancelVariation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const variation = await variationsService.cancel(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
  );
  res.json(variation);
}

export async function presignVariationAttachment(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = presignVariationAttachmentSchema.parse(req.body);
  const result = await variationsService.presignAttachment(
    auth.organisationId,
    req.params.id as string,
    input,
  );
  res.json(result);
}

export async function registerVariationAttachment(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = registerVariationAttachmentSchema.parse(req.body);
  const result = await variationsService.registerAttachment(
    auth.organisationId,
    auth.userId,
    req.params.id as string,
    input,
  );
  res.status(201).json(result);
}

export async function listVariationAttachments(req: Request, res: Response) {
  const auth = requireAuth(req);
  const result = await variationsService.listAttachments(
    auth.organisationId,
    req.params.id as string,
  );
  res.json(result);
}
