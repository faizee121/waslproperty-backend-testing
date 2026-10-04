import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../errors/AppError.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { AiService } from './ai.service.js';
import { startConversationSchema, continueConversationSchema } from './ai.schemas.js';

const aiService = new AiService(getPrismaClient());

function requireAuth(req: Request) {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

/** WEB is the only live channel — see ai.types.ts's AiChannel and the M14
 * report's channel-agnostic section for how a future adapter would set
 * this differently for its own requests. */
const WEB_CHANNEL = 'WEB' as const;

export async function getAiStatus(req: Request, res: Response) {
  const auth = requireAuth(req);
  const availability = await aiService.getAvailability(auth);
  res.json(availability);
}

export async function startAiConversation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = startConversationSchema.parse(req.body);
  const result = await aiService.startConversation(
    auth,
    WEB_CHANNEL,
    input.message,
    input.context,
    input.responseIntent,
  );
  res.status(201).json(result);
}

export async function continueAiConversation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const input = continueConversationSchema.parse(req.body);
  const result = await aiService.continueConversation(
    auth,
    WEB_CHANNEL,
    req.params.id as string,
    input.message,
    input.responseIntent,
  );
  res.json(result);
}

export async function listAiConversations(req: Request, res: Response) {
  const auth = requireAuth(req);
  const conversations = await aiService.listConversations(auth);
  res.json({ items: conversations });
}

export async function getAiConversation(req: Request, res: Response) {
  const auth = requireAuth(req);
  const result = await aiService.getConversation(auth, req.params.id as string);
  res.json(result);
}
