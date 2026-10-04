import type { AiChannel, OrgRole } from '@prisma/client';

export type { AiChannel };

/**
 * The trusted actor identity every AI tool call and audit row is stamped
 * with — built exactly once per request, server-side, from `req.auth` (see
 * context/actor-context.ts). The model never supplies any field here,
 * directly or indirectly: a tool's JSON-schema parameters never include
 * userId/organisationId/orgRole, so there is no argument shape through
 * which a prompt-injected instruction could even attempt to override
 * identity.
 */
export interface AiActorContext {
  userId: string;
  organisationId: string;
  orgRole: OrgRole | null;
  propertyContactId?: string | null;
  channel: AiChannel;
}

/**
 * The one resource type vocabulary shared by AiResponse.resources,
 * AiSuggestedAction, and every tool's evidence references — deliberately
 * flat strings the frontend maps to real routes (see the frontend's
 * resource-link component), never a URL the model could construct itself.
 */
export type AiResourceType =
  | 'MAINTENANCE_REQUEST'
  | 'WORK_ORDER'
  | 'CONTRACTOR_QUOTE'
  | 'QUOTE_ROUND'
  | 'CONTRACTOR'
  | 'PROPERTY'
  | 'WORK_ORDER_VARIATION'
  | 'COMMUNICATION';

/** A secure, structured reference to a real record — id and type only.
 * `reference`/`label` are always populated by the tool gateway from real
 * data the handler fetched, never accepted verbatim from the model (see
 * orchestrator/ai-orchestrator.ts's resource-reconciliation step). */
export interface AiResource {
  type: AiResourceType;
  id: string;
  /** Short human identifier, e.g. "Maintenance Request — Leaking tap". */
  reference: string;
  /** The customer-facing short code (e.g. "MR-P8X3DF") — see
   * src/lib/public-reference.ts. Null for a resource type that has none
   * (Contractor, ContractorQuote — see that file's model-scope decision).
   * Always sourced from a real tool-result row, never invented by the
   * model (see ai-orchestrator.ts's reconcileResource doc comment). */
  publicReference: string | null;
  label: string;
}

export type AiFindingSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type AiFindingType =
  'DELAY' | 'RISK' | 'PATTERN' | 'EXCEPTION' | 'DIFFERENCE' | 'COMPLIANCE' | 'INFO';

/** `factOrInference` is the one non-negotiable field of the whole
 * contract: FACT means every word came directly from tool-returned data
 * (a status, a date, an amount); AI_ANALYSIS means the model connected or
 * interpreted facts — always rendered with hedging language and always
 * visually distinguished by the frontend, never presented as certain. */
export interface AiFinding {
  type: AiFindingType;
  severity: AiFindingSeverity;
  title: string;
  explanation: string;
  factOrInference: 'FACT' | 'AI_ANALYSIS';
  evidence: AiResource[];
}

export interface AiSection {
  heading: string;
  body: string;
}

export type AiSuggestedAction =
  | {
      type: 'OPEN_RESOURCE';
      resourceType: AiResourceType;
      resourceId: string;
      publicReference: string | null;
      label: string;
    }
  | { type: 'ASK_FOLLOWUP'; prompt: string; label: string };

/**
 * The channel-neutral response contract every AI turn produces — no
 * React-specific or channel-specific shape. WEB renders it as structured
 * cards; a future WhatsApp adapter would render `answer` plus a
 * condensed summary of `findings`, from the exact same object, never a
 * separately-generated answer. See responseIntent on AiRequest for how a
 * channel asks for a lighter render without changing what evidence was
 * gathered.
 */
export interface AiResponse {
  answer: string;
  sections: AiSection[];
  findings: AiFinding[];
  resources: AiResource[];
  suggestedActions: AiSuggestedAction[];
  /** Set instead of a normal answer when the assistant needs the user to
   * disambiguate before it can proceed (e.g. more than one open request
   * matches "the leaking tap issue") — never a fabricated guess. */
  clarification?: string;
}

export interface AiResourceContext {
  resourceType: AiResourceType;
  resourceId: string;
}

/**
 * The one request shape every channel adapter builds — WEB today,
 * WHATSAPP/MOBILE/API are reserved. An adapter's only job is: authenticate
 * the caller, build this object, call AiService, render the AiResponse for
 * its own surface. Adapters never contain business rules, tool
 * definitions, or authorization logic — all of that lives in this module.
 */
export interface AiRequest {
  conversationId?: string;
  actorContext: AiActorContext;
  channel: AiChannel;
  message: string;
  context?: AiResourceContext;
  channelMetadata?: Record<string, unknown>;
  /** How much detail the channel wants back — SUMMARY/STANDARD/DETAILED —
   * so a future low-bandwidth channel (WhatsApp) can request a terser
   * render from the same evidence Web renders richly, without embedding
   * presentation logic into any domain tool. STANDARD unless specified. */
  responseIntent?: 'SUMMARY' | 'STANDARD' | 'DETAILED';
}

export type PreparedAiActionStatus =
  'PENDING_CONFIRMATION' | 'CONFIRMED' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';

/**
 * Design-only sketch for a future write-action workflow (Prepare ->
 * Validate -> Present Confirmation -> Explicit Confirm -> Re-authorize ->
 * Execute -> Audit) — nothing in M14 creates or executes one of these; no
 * table backs this type yet. It exists purely so a future write feature is
 * designed against a server-validated action object from day one, never a
 * simple re-send of model-generated parameters: confirmation always
 * re-verifies actor/organisation/permissions/resource-state/business-rules
 * against this record, not against anything the model said this turn.
 */
export interface PreparedAiAction {
  id: string;
  actorUserId: string;
  organisationId: string;
  actionType: string;
  validatedParameters: Record<string, unknown>;
  resourceContext: AiResourceContext | null;
  expiresAt: Date;
  status: PreparedAiActionStatus;
  createdAt: Date;
}
