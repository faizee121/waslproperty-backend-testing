import { env } from '../../../config/env.js';

export class AiBudgetExceededError extends Error {
  constructor(readonly guardrailEvent: string) {
    super(`AI execution budget exceeded: ${guardrailEvent}`);
  }
}

/**
 * Every configurable execution budget for one AI turn, enforced in one
 * place — fail-closed by design: exceeding any limit throws immediately,
 * the orchestrator catches it and returns a clear "couldn't complete"
 * response, and the caller records a guardrail event on the audit row.
 * Nothing here ever silently truncates and continues as if the limit
 * hadn't been hit.
 */
export class ExecutionBudget {
  private turns = 0;
  private totalToolCalls = 0;
  private toolCallCounts = new Map<string, number>();
  private totalOutputBytes = 0;
  private readonly startedAt = Date.now();

  assertCanTakeTurn(): void {
    if (this.turns >= env.AI_MAX_TURNS) {
      throw new AiBudgetExceededError('MAX_TURNS_EXCEEDED');
    }
    this.turns += 1;
  }

  assertCanCallTool(toolName: string): void {
    if (this.totalToolCalls >= env.AI_MAX_TOOL_CALLS) {
      throw new AiBudgetExceededError('MAX_TOOL_CALLS_EXCEEDED');
    }
    const count = this.toolCallCounts.get(toolName) ?? 0;
    if (count >= env.AI_MAX_TOOL_CALLS_PER_TOOL) {
      throw new AiBudgetExceededError('MAX_REPEATED_TOOL_CALLS_EXCEEDED');
    }
  }

  recordToolCall(toolName: string, outputByteLength: number): void {
    this.totalToolCalls += 1;
    this.toolCallCounts.set(toolName, (this.toolCallCounts.get(toolName) ?? 0) + 1);
    this.totalOutputBytes += outputByteLength;
    if (this.totalOutputBytes > env.AI_MAX_OUTPUT_TOKENS * 8) {
      // Rough token->byte heuristic (never exact) — bounds total tool
      // output fed back into context, independent of the model's own
      // final-answer token limit (AI_MAX_OUTPUT_TOKENS), which the
      // provider enforces separately.
      throw new AiBudgetExceededError('CONTEXT_SIZE_EXCEEDED');
    }
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}
