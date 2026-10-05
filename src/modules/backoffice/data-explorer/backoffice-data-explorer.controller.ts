import type { Request, Response } from 'express';
import { getPrismaClient } from '../../../lib/prisma.js';
import { UnauthorizedError } from '../../../errors/AppError.js';
import { BackofficeDataExplorerService } from './backoffice-data-explorer.service.js';
import {
  dataExplorerDeleteSchema,
  dataExplorerListQuerySchema,
  dataExplorerUpdateSchema,
} from './backoffice-data-explorer.schemas.js';

const service = new BackofficeDataExplorerService(getPrismaClient());

export async function listDataExplorerModels(_req: Request, res: Response) {
  res.json({ items: await service.listModels() });
}

export async function listDataExplorerRecords(req: Request, res: Response) {
  if (!req.platformAuth) throw new UnauthorizedError();
  const query = dataExplorerListQuerySchema.parse(req.query);
  res.json(
    await service.listRecords(
      req.params.model as string,
      query,
      req.platformAuth.platformCapabilities,
    ),
  );
}

export async function getDataExplorerRecord(req: Request, res: Response) {
  if (!req.platformAuth) throw new UnauthorizedError();
  res.json(
    await service.getRecord(
      req.params.model as string,
      req.params.id as string,
      req.platformAuth.platformCapabilities,
    ),
  );
}

export async function updateDataExplorerRecord(req: Request, res: Response) {
  if (!req.platformAuth) throw new UnauthorizedError();
  const input = dataExplorerUpdateSchema.parse(req.body);
  const updated = await service.updateRecord(
    req.params.model as string,
    req.params.id as string,
    input,
    { employeeId: req.platformAuth.employeeId, platformRole: req.platformAuth.platformRole },
    req.platformAuth.platformCapabilities,
  );
  res.json(updated);
}

export async function deleteDataExplorerRecord(req: Request, res: Response) {
  if (!req.platformAuth) throw new UnauthorizedError();
  const input = dataExplorerDeleteSchema.parse(req.body);
  await service.deleteRecord(req.params.model as string, req.params.id as string, input, {
    employeeId: req.platformAuth.employeeId,
    platformRole: req.platformAuth.platformRole,
  });
  res.status(204).send();
}
