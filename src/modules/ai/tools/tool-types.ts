import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { AuthContext } from '../../../middlewares/auth.middleware.js';
import type { Capability } from '../../authorization/capabilities.js';
import type { AiResource } from '../ai.types.js';

/**
 * Every tool exposed to the model is READ in M14 — there is no CONFIRM_WRITE
 * or CONTROLLED_WORKFLOW tool registered anywhere yet. The type exists
 * (rather than a bare boolean) so a future write tool slots into the same
 * registry/gateway shape without a redesign: CONFIRM_WRITE would require an
 * explicit user confirmation step and produce a PreparedAiAction (see
 * ai.types.ts) instead of executing directly; CONTROLLED_WORKFLOW would be
 * a bounded multi-step business process (never arbitrary code execution).
 */
export type AiToolRiskLevel = 'READ' | 'CONFIRM_WRITE' | 'CONTROLLED_WORKFLOW';

/** What a tool handler returns to the gateway — `data` is the AI-safe DTO
 * serialized into the tool result the model reads; `resources` is the set
 * of real, server-verified resource references this call touched, which
 * the orchestrator uses to validate anything the model later claims as
 * evidence (see orchestrator/ai-orchestrator.ts). A handler must never put
 * anything in `data` it wouldn't also be willing to put in `resources` —
 * both come from the same authorized, already-scoped query. */
export interface AiToolHandlerResult<TData> {
  data: TData;
  resources: AiResource[];
}

/**
 * One entry in the Secure Tool Gateway's allow-list. This is the ONLY
 * shape a capability can be exposed to the model through — there is no
 * generic "run a query"/"call an endpoint" tool anywhere, and there never
 * will be; every tool is domain/evidence-oriented, wraps exactly one
 * existing domain service call (or a small deterministic aggregate of a
 * few), and returns a bounded, pre-shaped DTO, never a raw Prisma entity.
 */
export interface AiToolDefinition<TParams = unknown, TData = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  /** JSON Schema equivalent of `parameters`, handed to the provider —
   * built once per tool via zod-to-json-schema-free hand mapping (see
   * tools/tools.ts's toJsonSchema helper) since every tool's parameter
   * shape here is intentionally simple (flat, few fields). */
  parametersJsonSchema: Record<string, unknown>;
  riskLevel: AiToolRiskLevel;
  /** The capability required to run this tool at all. Combined with
   * `resolvePropertyId` (when present) for a property-scoped check; a
   * coarse "does the user hold this capability anywhere" check otherwise —
   * exactly mirroring requireCapability's own two modes. */
  requiredCapability: Capability;
  /** Re-derives the owning propertyId from the ALREADY-VALIDATED
   * parameters via a real database lookup scoped to organisationId — never
   * trusts a propertyId the model might have supplied directly as
   * authorization-bearing. Omit only for a genuinely portfolio-wide tool,
   * whose handler must itself scope every query through
   * AuthorizationService.getAccessiblePropertyIds. */
  resolvePropertyId?: (
    prisma: PrismaClient,
    organisationId: string,
    params: TParams,
  ) => Promise<string | undefined>;
  handler: (
    prisma: PrismaClient,
    organisationId: string,
    auth: AuthContext,
    params: TParams,
  ) => Promise<AiToolHandlerResult<TData>>;
}
