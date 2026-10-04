import type { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../../../middlewares/auth.middleware.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { env } from '../../../config/env.js';
import type { AiResource } from '../ai.types.js';
import type { ExecutionBudget } from '../budget/execution-budget.js';
import { AI_TOOLS_BY_NAME } from '../tools/tools.js';

export class AiToolExecutionError extends Error {
  constructor(
    readonly code:
      'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'FORBIDDEN' | 'NOT_FOUND' | 'TIMEOUT' | 'INTERNAL',
    message: string,
  ) {
    super(message);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AiToolExecutionError('TIMEOUT', `Tool ${label} timed out`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface AiToolExecutionResult {
  toolResultJson: string;
  resources: AiResource[];
}

/**
 * The Secure Tool Gateway — the ONLY path from a model-requested tool call
 * to real data. Every invocation, regardless of which tool, performs the
 * same sequence: (1) reject anything not in the allow-list by name, (2)
 * validate arguments against that tool's own strict schema, (3) enforce
 * execution budgets before doing any work, (4) re-derive the owning
 * property/resource server-side from the validated arguments (never trust
 * a caller-supplied id as authorization-bearing on its own), (5) check the
 * real AuthorizationService for the trusted actor — never a role/capability
 * the model claims, (6) run the handler under a timeout, (7) bound the
 * output size, (8) record the call against the budget, (9) return only the
 * tool's own declared AI-safe DTO plus the resources it touched. A tool
 * that isn't in AI_TOOLS_BY_NAME simply cannot be reached from here — there
 * is no fallback generic executor.
 */
export async function executeAiTool(
  prisma: PrismaClient,
  toolName: string,
  rawArgs: unknown,
  organisationId: string,
  auth: AuthContext,
  budget: ExecutionBudget,
): Promise<AiToolExecutionResult> {
  const tool = AI_TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    throw new AiToolExecutionError('UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
  }

  budget.assertCanCallTool(toolName);

  const parsed = tool.parameters.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new AiToolExecutionError('INVALID_ARGUMENTS', `Invalid arguments for ${toolName}`);
  }

  const propertyId = tool.resolvePropertyId
    ? await tool.resolvePropertyId(prisma, organisationId, parsed.data)
    : undefined;

  const authorizationService = new AuthorizationService(prisma);
  const allowed = await authorizationService.can(auth, tool.requiredCapability, propertyId);
  if (!allowed) {
    if (tool.resolvePropertyId && propertyId === undefined) {
      // Mirrors requireCapability's own 404-not-403 rule — a resource this
      // organisation doesn't own (or that doesn't exist) is
      // indistinguishable from "not authorized", never leaking existence.
      throw new AiToolExecutionError('NOT_FOUND', 'Resource not found or inaccessible');
    }
    throw new AiToolExecutionError('FORBIDDEN', `Not authorised to use ${toolName}`);
  }

  const { data, resources } = await withTimeout(
    tool.handler(prisma, organisationId, auth, parsed.data),
    env.AI_TOOL_TIMEOUT_MS,
    toolName,
  );

  const toolResultJson = JSON.stringify(data);
  budget.recordToolCall(toolName, toolResultJson.length);

  return { toolResultJson, resources };
}
