import type { PrismaClient, WorkflowMode } from '@prisma/client';
import { NotFoundError } from '../../errors/AppError.js';
import { recordActivity } from '../activity/activity.js';
import type { UpsertApprovalPolicyInput } from './approval-policy.schemas.js';

function toCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

function formatMoney(amount: number | string, currencyCode: string): string {
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
  return `${currencyCode} ${formatted}`;
}

const WORKFLOW_MODE_LABEL: Record<WorkflowMode, string> = {
  NONE: 'no approval or signature',
  APPROVAL_ONLY: 'approval',
  SIGNATURE_ONLY: 'signature',
  APPROVAL_THEN_SIGNATURE: 'approval and signature',
};

/** Which gate(s) a workflow mode actually requires — the two independent
 * axes (an internal approval decision, a formal signature) that
 * APPROVAL_ONLY and SIGNATURE_ONLY each satisfy exactly one of, and
 * APPROVAL_THEN_SIGNATURE satisfies both of. Used to decide whether one
 * mode is "at least as strong" as another without inventing a single
 * total ordering across two genuinely different modes (see
 * meetsOrExceedsRequirement's doc comment). */
export function requiredGates(mode: WorkflowMode): { approval: boolean; signature: boolean } {
  return {
    approval: mode === 'APPROVAL_ONLY' || mode === 'APPROVAL_THEN_SIGNATURE',
    signature: mode === 'SIGNATURE_ONLY' || mode === 'APPROVAL_THEN_SIGNATURE',
  };
}

/**
 * True if `chosen` satisfies every gate `required` mandates — i.e. chosen
 * is at least as strong, never weaker. APPROVAL_ONLY and SIGNATURE_ONLY are
 * NOT comparable to each other (neither is "weaker"): a policy requiring
 * APPROVAL_ONLY is only satisfied by APPROVAL_ONLY or
 * APPROVAL_THEN_SIGNATURE, never by swapping in SIGNATURE_ONLY instead —
 * that would drop the mandated approval gate even though it adds a
 * different one.
 */
export function meetsOrExceedsRequirement(chosen: WorkflowMode, required: WorkflowMode): boolean {
  const c = requiredGates(chosen);
  const r = requiredGates(required);
  return (!r.approval || c.approval) && (!r.signature || c.signature);
}

export interface ApprovalPolicyResolution {
  /** Null means no floor is enforced — either no enabled policy exists, or
   * the requested currency doesn't match the policy's own currency. In
   * both cases a manager must explicitly choose a workflow; never silently
   * treated as NONE. */
  workflowMode: WorkflowMode | null;
  policyConfigured: boolean;
  currencyMismatch: boolean;
  policyId: string | null;
  policyCurrencyCode: string | null;
  matchedRuleId: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  /** Plain-language, generated only from the actual configured rule this
   * resolution matched — never fabricated boilerplate. Frozen onto the
   * record that requested this resolution (see ContractorQuote.
   * approvalPolicySnapshot) so a later policy edit can't retroactively
   * change what a historical decision says it required. */
  reason: string;
}

/**
 * The single source of truth for "does this commercial commitment need
 * Approval & Acceptance, and if so what shape" — replaces the old
 * env-var-driven `amount >= WORK_ORDER_WASLSIGN_THRESHOLD_AED` check
 * (quotes.service.ts's former defaultWorkflowMode). Called from exactly
 * three places: QuotesService.create (Direct Work, at the moment a quote —
 * the commercial commitment — is first recorded), QuoteRoundsService.award
 * (RFQ, at the moment a quote is selected/awarded — receiving a quote is
 * NOT a resolution point, only being selected is), and
 * WorkOrderVariationsService.create (a proposed variation, evaluated on
 * its own amount — see that service's doc comment for why, not the
 * resulting authorised total). Never call this from anywhere else, and
 * never re-implement the amount-to-workflow comparison outside this class.
 *
 * Shaped so future policy dimensions (property, maintenance category, work
 * type, procurement path, emergency work, variation-vs-original-quote) can
 * be added to `resolve`'s input and to ApprovalPolicyRule without changing
 * this class's callers — none of those dimensions are implemented yet,
 * deliberately, since nothing today requires them.
 */
export class ApprovalPolicyService {
  constructor(private readonly prisma: PrismaClient) {}

  async getPolicy(organisationId: string) {
    return this.prisma.organisationApprovalPolicy.findUnique({
      where: { organisationId },
      include: { rules: { orderBy: { minAmount: 'asc' } }, updatedByUser: true, createdBy: true },
    });
  }

  /**
   * Replaces the whole rule set atomically. Deliberately not a per-rule
   * CRUD API (unlike ContractorComplianceRequirement) — an amount-banded
   * policy only makes sense as one coherent, gapless, non-overlapping
   * ordered set, so editing is "redefine the bands," not "add one row."
   * minAmount for each band is derived here, never trusted from the
   * client: band 0 always starts at 0; band N starts exactly one cent
   * above band N-1's cap. This is what makes overlapping or gapped ranges
   * structurally impossible rather than merely validated.
   */
  async upsertPolicy(
    organisationId: string,
    actorUserId: string,
    input: UpsertApprovalPolicyInput,
  ) {
    const existing = await this.prisma.organisationApprovalPolicy.findUnique({
      where: { organisationId },
    });

    const ruleData = input.rules.map((rule, index) => {
      const minCents = index === 0 ? 0 : toCents(input.rules[index - 1]!.maxAmount as number) + 1;
      return {
        organisationId,
        minAmount: (minCents / 100).toFixed(2),
        maxAmount: rule.maxAmount === null ? null : rule.maxAmount.toFixed(2),
        workflowMode: rule.workflowMode,
      };
    });

    const policy = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.organisationApprovalPolicy.upsert({
        where: { organisationId },
        create: {
          organisationId,
          currencyCode: input.currencyCode,
          enabled: input.enabled,
          createdByUserId: actorUserId,
        },
        update: {
          currencyCode: input.currencyCode,
          enabled: input.enabled,
          updatedByUserId: actorUserId,
        },
      });

      // Replace-in-full: simplest correct way to guarantee the persisted
      // set is exactly the contiguous, gapless set just validated — a
      // partial per-row diff invites exactly the overlap/gap bugs this
      // design exists to prevent.
      await tx.approvalPolicyRule.deleteMany({ where: { policyId: saved.id } });
      await tx.approvalPolicyRule.createMany({
        data: ruleData.map((r) => ({ ...r, policyId: saved.id })),
      });

      await recordActivity(tx, {
        organisationId,
        actorUserId,
        eventType: 'APPROVAL_POLICY_UPDATED',
        entityType: 'OrganisationApprovalPolicy',
        entityId: saved.id,
        title: existing
          ? `Approval & Acceptance policy updated (${ruleData.length} rule${ruleData.length === 1 ? '' : 's'}, ${input.currencyCode}${input.enabled ? '' : ', disabled'})`
          : `Approval & Acceptance policy configured (${ruleData.length} rule${ruleData.length === 1 ? '' : 's'}, ${input.currencyCode})`,
      });

      return saved;
    });

    return this.getOwned(organisationId, policy.id);
  }

  private async getOwned(organisationId: string, policyId: string) {
    const policy = await this.prisma.organisationApprovalPolicy.findFirst({
      where: { id: policyId, organisationId },
      include: { rules: { orderBy: { minAmount: 'asc' } } },
    });
    if (!policy) throw new NotFoundError('Approval policy not found');
    return policy;
  }

  /** Disables (never deletes) the policy — rules are preserved so
   * re-enabling doesn't require re-entering them. A disabled policy
   * behaves identically to "not configured" for resolve(). */
  async disable(organisationId: string, actorUserId: string) {
    const existing = await this.prisma.organisationApprovalPolicy.findUnique({
      where: { organisationId },
    });
    if (!existing) throw new NotFoundError('Approval policy not found');
    if (!existing.enabled) return existing;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.organisationApprovalPolicy.update({
        where: { organisationId },
        data: { enabled: false, updatedByUserId: actorUserId },
      });
      await recordActivity(tx, {
        organisationId,
        actorUserId,
        eventType: 'APPROVAL_POLICY_UPDATED',
        entityType: 'OrganisationApprovalPolicy',
        entityId: updated.id,
        title: 'Approval & Acceptance policy disabled',
      });
      return updated;
    });
  }

  /**
   * The one place an amount+currency ever becomes a required workflow.
   * Never throws for "no policy" or "currency mismatch" — both are valid,
   * safe states the caller must handle explicitly (see
   * ApprovalPolicyResolution.workflowMode's doc comment), not exceptions.
   */
  async resolve(
    organisationId: string,
    amount: number | string,
    currencyCode: string,
  ): Promise<ApprovalPolicyResolution> {
    const policy = await this.prisma.organisationApprovalPolicy.findUnique({
      where: { organisationId },
      include: { rules: { orderBy: { minAmount: 'asc' } } },
    });

    if (!policy || !policy.enabled || policy.rules.length === 0) {
      return {
        workflowMode: null,
        policyConfigured: false,
        currencyMismatch: false,
        policyId: policy?.id ?? null,
        policyCurrencyCode: policy?.currencyCode ?? null,
        matchedRuleId: null,
        minAmount: null,
        maxAmount: null,
        reason:
          'No Approval & Acceptance policy is configured for this organisation — choose a workflow manually.',
      };
    }

    if (policy.currencyCode !== currencyCode) {
      return {
        workflowMode: null,
        policyConfigured: true,
        currencyMismatch: true,
        policyId: policy.id,
        policyCurrencyCode: policy.currencyCode,
        matchedRuleId: null,
        minAmount: null,
        maxAmount: null,
        reason: `This amount is in ${currencyCode}, but the organisation's Approval & Acceptance policy is configured in ${policy.currencyCode} — no rule can be applied automatically. Choose a workflow manually.`,
      };
    }

    const amountCents = toCents(amount);
    const matched = policy.rules.find((rule) => {
      const minCents = toCents(rule.minAmount.toString());
      const maxCents = rule.maxAmount === null ? null : toCents(rule.maxAmount.toString());
      return amountCents >= minCents && (maxCents === null || amountCents <= maxCents);
    });

    if (!matched) {
      // Should be unreachable given upsertPolicy's contiguous/open-ended
      // guarantee — defensive fallback only, never silently NONE.
      return {
        workflowMode: null,
        policyConfigured: true,
        currencyMismatch: false,
        policyId: policy.id,
        policyCurrencyCode: policy.currencyCode,
        matchedRuleId: null,
        minAmount: null,
        maxAmount: null,
        reason: 'This amount did not match any configured band — choose a workflow manually.',
      };
    }

    const label = WORKFLOW_MODE_LABEL[matched.workflowMode];
    const reason =
      matched.maxAmount === null
        ? `Amounts of ${formatMoney(matched.minAmount.toString(), policy.currencyCode)} or more require ${label}, per organisation policy.`
        : matched.minAmount.toString() === '0.00'
          ? `Amounts up to ${formatMoney(matched.maxAmount.toString(), policy.currencyCode)} require ${label}, per organisation policy.`
          : `Amounts from ${formatMoney(matched.minAmount.toString(), policy.currencyCode)} to ${formatMoney(matched.maxAmount.toString(), policy.currencyCode)} require ${label}, per organisation policy.`;

    return {
      workflowMode: matched.workflowMode,
      policyConfigured: true,
      currencyMismatch: false,
      policyId: policy.id,
      policyCurrencyCode: policy.currencyCode,
      matchedRuleId: matched.id,
      minAmount: matched.minAmount.toString(),
      maxAmount: matched.maxAmount?.toString() ?? null,
      reason,
    };
  }
}
