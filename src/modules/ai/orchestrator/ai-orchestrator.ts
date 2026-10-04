import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../../../middlewares/auth.middleware.js';
import { env } from '../../../config/env.js';
import { getAiProvider } from '../providers/provider-factory.js';
import type {
  AiProviderMessage,
  AiToolDefinitionForProvider,
} from '../providers/ai-provider.interface.js';
import { AI_TOOLS } from '../tools/tools.js';
import { executeAiTool, AiToolExecutionError } from '../gateway/tool-gateway.js';
import { ExecutionBudget, AiBudgetExceededError } from '../budget/execution-budget.js';
import { buildSystemPrompt, RESPONSE_CONTRACT_INSTRUCTIONS } from './system-prompt.js';
import type {
  AiActorContext,
  AiFinding,
  AiResource,
  AiResourceContext,
  AiResponse,
  AiSuggestedAction,
} from '../ai.types.js';

function toolsForProvider(): AiToolDefinitionForProvider[] {
  return AI_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parametersJsonSchema,
  }));
}

function fallbackResponse(message: string): AiResponse {
  return { answer: message, sections: [], findings: [], resources: [], suggestedActions: [] };
}

const rawResourceRefSchema = z.object({ type: z.string(), id: z.string() });
const rawFindingSchema = z.object({
  type: z.string(),
  severity: z.string(),
  title: z.string(),
  explanation: z.string(),
  factOrInference: z.enum(['FACT', 'AI_ANALYSIS']),
  evidence: z.array(rawResourceRefSchema).optional().default([]),
});
const rawSectionSchema = z.object({ heading: z.string(), body: z.string() });
const rawSuggestedActionSchema = z.union([
  z.object({
    type: z.literal('OPEN_RESOURCE'),
    resourceType: z.string(),
    resourceId: z.string(),
    label: z.string(),
  }),
  z.object({ type: z.literal('ASK_FOLLOWUP'), prompt: z.string(), label: z.string() }),
]);
const rawResponseSchema = z.object({
  answer: z.string(),
  sections: z.array(rawSectionSchema).optional().default([]),
  findings: z.array(rawFindingSchema).optional().default([]),
  resources: z.array(rawResourceRefSchema).optional().default([]),
  suggestedActions: z.array(rawSuggestedActionSchema).optional().default([]),
  clarification: z.string().optional(),
});

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

/** The one place the model's own claims about resources/evidence are
 * reconciled against what tools ACTUALLY returned this turn — anything the
 * model references that never appeared in a real tool result is silently
 * dropped, never trusted. This is what makes "the model can never generate
 * an arbitrary URL/id" true in practice, not just in the prompt. */
function reconcileResource(
  ref: { type: string; id: string },
  collected: Map<string, AiResource>,
): AiResource | null {
  return collected.get(`${ref.type}:${ref.id}`) ?? null;
}

function parseFinalResponse(
  content: string,
  collected: Map<string, AiResource>,
): { response: AiResponse; malformed: boolean } {
  try {
    const raw = rawResponseSchema.parse(extractJson(content));

    const resources = raw.resources
      .map((r) => reconcileResource(r, collected))
      .filter((r): r is AiResource => r !== null);

    const findings: AiFinding[] = raw.findings.map((f) => ({
      type: f.type as AiFinding['type'],
      severity: f.severity as AiFinding['severity'],
      title: f.title,
      explanation: f.explanation,
      factOrInference: f.factOrInference,
      evidence: f.evidence
        .map((e) => reconcileResource(e, collected))
        .filter((r): r is AiResource => r !== null),
    }));

    // For OPEN_RESOURCE, the model's own `label` is never trusted (see this
    // file's doc comment on reconcileResource) — only the id is used, to
    // look up the SAME trusted AiResource a real tool call produced this
    // turn. A model-invented label here is exactly how a raw id/CUID could
    // otherwise leak into "Open <label>" UI text.
    const suggestedActions: AiSuggestedAction[] = raw.suggestedActions.flatMap((a) => {
      if (a.type !== 'OPEN_RESOURCE') return [a as AiSuggestedAction];
      const resource = collected.get(`${a.resourceType}:${a.resourceId}`);
      if (!resource) return [];
      return [
        {
          type: 'OPEN_RESOURCE',
          resourceType: resource.type,
          resourceId: resource.id,
          publicReference: resource.publicReference,
          label: resource.label,
        },
      ];
    });

    return {
      response: {
        answer: raw.answer,
        sections: raw.sections,
        findings,
        resources,
        suggestedActions,
        clarification: raw.clarification,
      },
      malformed: false,
    };
  } catch {
    return {
      response: fallbackResponse(
        "I wasn't able to produce a structured answer for that — could you try rephrasing your question?",
      ),
      malformed: true,
    };
  }
}

export interface AiOrchestrationResult {
  response: AiResponse;
  toolNames: string[];
  guardrailEvent: string | null;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
}

export interface RunAiOrchestrationParams {
  prisma: PrismaClient;
  organisationId: string;
  auth: AuthContext;
  actorContext: AiActorContext;
  message: string;
  /** Prior turns' plain user/assistant content only — never the
   * intermediate tool-call exchange of a past turn (see
   * conversation/ai-conversation.service.ts's own doc comment on why). */
  history: AiProviderMessage[];
  resourceContext?: AiResourceContext;
  responseIntent?: string;
}

/**
 * The AI turn loop: call the provider with the allow-listed tools, execute
 * any tool calls it requests through the Secure Tool Gateway, feed results
 * back, repeat until it has no more tool calls, then validate and
 * reconcile its final structured answer. Every exit path — provider
 * unavailable, budget exceeded, malformed final output, an unexpected
 * error — returns a safe AiResponse rather than propagating a fabricated
 * or partial answer; see fallbackResponse.
 */
export async function runAiOrchestration(
  params: RunAiOrchestrationParams,
): Promise<AiOrchestrationResult> {
  const provider = getAiProvider('ROUTINE');
  if (!provider) {
    return {
      response: fallbackResponse("Wasl AI isn't available right now — please try again shortly."),
      toolNames: [],
      guardrailEvent: 'PROVIDER_UNAVAILABLE',
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: env.AI_PROVIDER,
      model: 'none',
    };
  }

  const budget = new ExecutionBudget();
  const systemPrompt = [
    buildSystemPrompt(params.resourceContext, params.responseIntent),
    RESPONSE_CONTRACT_INSTRUCTIONS,
  ].join('\n\n');
  const messages: AiProviderMessage[] = [
    ...params.history,
    { role: 'user', content: params.message },
  ];
  const tools = toolsForProvider();
  const toolNames: string[] = [];
  const collectedResources = new Map<string, AiResource>();
  const usage = { inputTokens: 0, outputTokens: 0 };

  try {
    for (;;) {
      budget.assertCanTakeTurn();
      const result = await provider.chat({
        systemPrompt,
        messages,
        tools,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        timeoutMs: env.AI_PROVIDER_TIMEOUT_MS,
      });
      if (result.usage) {
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
      }
      messages.push(result.message);

      if (!result.message.toolCalls || result.message.toolCalls.length === 0) {
        const { response, malformed } = parseFinalResponse(
          result.message.content,
          collectedResources,
        );
        return {
          response,
          toolNames,
          guardrailEvent: malformed ? 'MALFORMED_RESPONSE' : null,
          usage,
          provider: provider.name,
          model: provider.model,
        };
      }

      for (const call of result.message.toolCalls) {
        let argsObj: unknown = {};
        try {
          argsObj = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ error: 'Invalid JSON arguments' }),
          });
          continue;
        }

        try {
          const { toolResultJson, resources } = await executeAiTool(
            params.prisma,
            call.name,
            argsObj,
            params.organisationId,
            params.auth,
            budget,
          );
          toolNames.push(call.name);
          for (const r of resources) collectedResources.set(`${r.type}:${r.id}`, r);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: toolResultJson,
          });
        } catch (err) {
          // Budget exhaustion and an unknown-tool request both abort the
          // whole turn immediately (caught by the outer handler below) —
          // neither is fed back to the model as "try something else", since
          // that would just spend more of an already-exhausted budget.
          // Every other tool failure (not found, forbidden, invalid
          // arguments, timeout) is reported back to the model as this
          // call's result, so it can adjust or tell the user plainly.
          if (err instanceof AiBudgetExceededError) throw err;
          if (err instanceof AiToolExecutionError && err.code === 'UNKNOWN_TOOL') throw err;

          const message = err instanceof Error ? err.message : 'Tool execution failed';
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ error: message }),
          });
        }
      }
    }
  } catch (err) {
    if (err instanceof AiBudgetExceededError) {
      return {
        response: fallbackResponse(
          "I wasn't able to finish this investigation within the allotted steps — try narrowing your question to one request, quote, or property.",
        ),
        toolNames,
        guardrailEvent: err.guardrailEvent,
        usage,
        provider: provider.name,
        model: provider.model,
      };
    }
    return {
      response: fallbackResponse(
        'Something went wrong while investigating this — please try again.',
      ),
      toolNames,
      guardrailEvent:
        err instanceof AiToolExecutionError && err.code === 'UNKNOWN_TOOL'
          ? 'UNKNOWN_TOOL_REJECTED'
          : 'PROVIDER_ERROR',
      usage,
      provider: provider.name,
      model: provider.model,
    };
  }
}
