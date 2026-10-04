import type { AiChannel, PrismaClient } from '@prisma/client';
import type { AiResourceContext } from '../ai.types.js';

export interface RecordAiAuditEventInput {
  organisationId: string;
  userId: string;
  conversationId?: string;
  channel: AiChannel;
  provider: string;
  model: string;
  toolNames: string[];
  targetResource?: AiResourceContext;
  success: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  guardrailEvent?: string | null;
  errorCode?: string;
}

/**
 * Every AI turn's audit trail — deliberately metadata-only. Written here:
 * who/org/conversation/channel/provider/model, which tools ran (names
 * only, in order), which resource (if any) the turn was scoped to,
 * success/failure, latency, token usage, and which guardrail (if any)
 * fired. Never written: the user's message text, the model's answer text,
 * any tool arguments or results, or any chain-of-thought — none of that
 * belongs in an audit trail, and this service has no parameter shape that
 * would even let a caller pass it in by mistake.
 */
export class AiAuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordAiAuditEventInput): Promise<void> {
    await this.prisma.aiAuditEvent.create({
      data: {
        organisationId: input.organisationId,
        userId: input.userId,
        conversationId: input.conversationId,
        channel: input.channel,
        provider: input.provider,
        model: input.model,
        toolNames: input.toolNames,
        targetResourceType: input.targetResource?.resourceType,
        targetResourceId: input.targetResource?.resourceId,
        success: input.success,
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        guardrailEvent: input.guardrailEvent ?? undefined,
        errorCode: input.errorCode,
      },
    });
  }
}
