import type { AiChannel } from '@prisma/client';
import type { AuthContext } from '../../../middlewares/auth.middleware.js';
import type { AiActorContext } from '../ai.types.js';

/**
 * The ONE place an AiActorContext is ever constructed — always from a
 * server-verified `req.auth` (itself only ever produced by
 * `authenticate`/token verification, never from request body/headers the
 * caller controls), never from anything the model, a tool argument, or a
 * channel payload supplies. A future channel adapter (WhatsApp, etc.) must
 * still resolve its caller to a real AuthContext-equivalent identity
 * before it may call this — see the M14 report's channel-agnostic section.
 */
export function buildAiActorContext(auth: AuthContext, channel: AiChannel): AiActorContext {
  return {
    userId: auth.userId,
    organisationId: auth.organisationId,
    orgRole: auth.orgRole,
    propertyContactId: auth.propertyContactId ?? null,
    channel,
  };
}
