import type { AiChannel, PrismaClient } from '@prisma/client';
import { AppError, ForbiddenError } from '../../errors/AppError.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { buildAiActorContext } from './context/actor-context.js';
import { isAiPlatformAvailable } from './providers/provider-factory.js';
import { runAiOrchestration } from './orchestrator/ai-orchestrator.js';
import { AiConversationService } from './conversation/ai-conversation.service.js';
import { AiAuditService } from './audit/ai-audit.service.js';
import { aiRateLimiter } from './rate-limit/ai-rate-limiter.js';
import type { AiResourceContext, AiResourceType, AiResponse } from './ai.types.js';

export interface AiAvailability {
  available: boolean;
  reason?: 'PLATFORM_DISABLED' | 'ORGANISATION_DISABLED' | 'NOT_AUTHORISED';
}

/**
 * The single entry point every channel adapter calls (WEB today; see the
 * M14 report for why WHATSAPP/MOBILE/API only ever add adapters, never
 * touch this class). Owns the kill-switch check (all three of: platform
 * AI_ENABLED, this organisation's aiEnabled toggle, and the requesting
 * user's `ai.use` capability — never just one), rate limiting, conversation
 * persistence, and audit — delegating the actual tool-using reasoning to
 * runAiOrchestration.
 */
export class AiService {
  private readonly authz: AuthorizationService;
  private readonly conversations: AiConversationService;
  private readonly audit: AiAuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.authz = new AuthorizationService(prisma);
    this.conversations = new AiConversationService(prisma);
    this.audit = new AiAuditService(prisma);
  }

  async getAvailability(auth: AuthContext): Promise<AiAvailability> {
    if (!isAiPlatformAvailable()) return { available: false, reason: 'PLATFORM_DISABLED' };

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: auth.organisationId },
      select: { aiEnabled: true },
    });
    if (!organisation?.aiEnabled) return { available: false, reason: 'ORGANISATION_DISABLED' };

    const allowed = await this.authz.can(auth, 'ai.use');
    if (!allowed) return { available: false, reason: 'NOT_AUTHORISED' };

    return { available: true };
  }

  private async assertAvailable(auth: AuthContext): Promise<void> {
    const availability = await this.getAvailability(auth);
    if (!availability.available) {
      throw new ForbiddenError(`Wasl AI is not available (${availability.reason})`);
    }
  }

  private assertRateLimit(auth: AuthContext): void {
    if (!aiRateLimiter.tryConsume(auth.organisationId, auth.userId)) {
      throw new AppError(
        'AI_RATE_LIMITED',
        'Too many AI requests — please wait a moment and try again.',
        429,
      );
    }
  }

  async startConversation(
    auth: AuthContext,
    channel: AiChannel,
    message: string,
    resourceContext?: AiResourceContext,
    responseIntent?: 'SUMMARY' | 'STANDARD' | 'DETAILED',
  ): Promise<{ conversationId: string; response: AiResponse }> {
    await this.assertAvailable(auth);
    this.assertRateLimit(auth);

    const conversation = await this.conversations.start(
      auth.organisationId,
      auth.userId,
      channel,
      resourceContext,
    );
    const response = await this.runTurn(
      auth,
      channel,
      conversation.id,
      message,
      resourceContext,
      responseIntent,
    );
    return { conversationId: conversation.id, response };
  }

  async continueConversation(
    auth: AuthContext,
    channel: AiChannel,
    conversationId: string,
    message: string,
    responseIntent?: 'SUMMARY' | 'STANDARD' | 'DETAILED',
  ): Promise<{ response: AiResponse }> {
    await this.assertAvailable(auth);
    this.assertRateLimit(auth);

    const conversation = await this.conversations.getOwned(
      auth.organisationId,
      auth.userId,
      conversationId,
    );
    const resourceContext: AiResourceContext | undefined =
      conversation.contextResourceType && conversation.contextResourceId
        ? {
            resourceType: conversation.contextResourceType as AiResourceType,
            resourceId: conversation.contextResourceId,
          }
        : undefined;

    const response = await this.runTurn(
      auth,
      channel,
      conversation.id,
      message,
      resourceContext,
      responseIntent,
    );
    return { response };
  }

  private async runTurn(
    auth: AuthContext,
    channel: AiChannel,
    conversationId: string,
    message: string,
    resourceContext: AiResourceContext | undefined,
    responseIntent: 'SUMMARY' | 'STANDARD' | 'DETAILED' | undefined,
  ): Promise<AiResponse> {
    const actorContext = buildAiActorContext(auth, channel);
    const history = await this.conversations.getHistoryAsProviderMessages(conversationId);
    await this.conversations.appendUserMessage(conversationId, message);

    const startedAt = Date.now();
    const result = await runAiOrchestration({
      prisma: this.prisma,
      organisationId: auth.organisationId,
      auth,
      actorContext,
      message,
      history,
      resourceContext,
      responseIntent,
    });

    await this.conversations.appendAssistantMessage(conversationId, result.response);
    await this.audit.record({
      organisationId: auth.organisationId,
      userId: auth.userId,
      conversationId,
      channel,
      provider: result.provider,
      model: result.model,
      toolNames: result.toolNames,
      targetResource: resourceContext,
      success: result.guardrailEvent === null,
      latencyMs: Date.now() - startedAt,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      guardrailEvent: result.guardrailEvent,
    });

    return result.response;
  }

  async listConversations(auth: AuthContext) {
    return this.conversations.listMine(auth.organisationId, auth.userId);
  }

  async getConversation(auth: AuthContext, conversationId: string) {
    return this.conversations.getWithMessages(auth.organisationId, auth.userId, conversationId);
  }
}
