import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { requireCapability } from '../../middlewares/authorize.middleware.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import {
  continueAiConversation,
  getAiConversation,
  getAiStatus,
  listAiConversations,
  startAiConversation,
} from './ai.controller.js';

export const aiRouter = Router();

aiRouter.use(authenticate);

// Unauthenticated-capability-wise on purpose: the frontend needs to know
// WHY the AI entry point is hidden (platform off / org off / not
// authorised) before the user holds `ai.use`, not just get a 403.
aiRouter.get('/status', asyncHandler(getAiStatus));

aiRouter.use(requireCapability('ai.use'));
aiRouter.post('/conversations', asyncHandler(startAiConversation));
aiRouter.get('/conversations', asyncHandler(listAiConversations));
aiRouter.get('/conversations/:id', asyncHandler(getAiConversation));
aiRouter.post('/conversations/:id/messages', asyncHandler(continueAiConversation));
