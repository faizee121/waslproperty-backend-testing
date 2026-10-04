import type { AiChannel, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../../errors/AppError.js';
import type { AiProviderMessage } from '../providers/ai-provider.interface.js';
import type { AiResourceContext, AiResponse } from '../ai.types.js';

const HISTORY_TURN_LIMIT = 10;

/**
 * Bounded, channel-neutral conversation persistence. Deliberately shallow:
 * only the user's plain message and the assistant's final answer text are
 * stored — never the intermediate tool-call exchange, never
 * chain-of-thought. That keeps history small (bounded to the most recent
 * turns) and means a later turn's context never leaks one tool's raw
 * output back into a subsequent unrelated question; each turn's
 * investigation is fresh.
 *
 * Kept conceptually separate from Notifications and Communications — see
 * the M14 final report — since a future WhatsApp message may originate
 * from any of the three and they are never automatically interchangeable.
 */
export class AiConversationService {
  constructor(private readonly prisma: PrismaClient) {}

  async start(
    organisationId: string,
    userId: string,
    channel: AiChannel,
    resourceContext?: AiResourceContext,
  ) {
    return this.prisma.aiConversation.create({
      data: {
        organisationId,
        userId,
        channel,
        contextResourceType: resourceContext?.resourceType,
        contextResourceId: resourceContext?.resourceId,
      },
    });
  }

  async getOwned(organisationId: string, userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organisationId, userId },
    });
    if (!conversation) throw new NotFoundError('Conversation not found');
    return conversation;
  }

  async getHistoryAsProviderMessages(conversationId: string): Promise<AiProviderMessage[]> {
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURN_LIMIT,
    });
    return messages.reverse().map((m) => ({
      role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }));
  }

  async appendUserMessage(conversationId: string, content: string) {
    await this.prisma.aiMessage.create({ data: { conversationId, role: 'USER', content } });
  }

  async appendAssistantMessage(conversationId: string, response: AiResponse) {
    await this.prisma.$transaction([
      this.prisma.aiMessage.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: response.answer,
          structuredResponse: response as unknown as object,
        },
      }),
      this.prisma.aiConversation.update({
        where: { id: conversationId },
        data: { lastActiveAt: new Date() },
      }),
    ]);
  }

  async listMine(organisationId: string, userId: string, limit = 20) {
    return this.prisma.aiConversation.findMany({
      where: { organisationId, userId },
      orderBy: { lastActiveAt: 'desc' },
      take: limit,
    });
  }

  async getWithMessages(organisationId: string, userId: string, conversationId: string) {
    const conversation = await this.getOwned(organisationId, userId, conversationId);
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    return { conversation, messages };
  }
}
