import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError.js';
import { env } from '../../config/env.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { logger } from '../../lib/logger.js';
import { presignGet, presignPut } from '../../lib/s3.js';
import { generateVariationAcceptanceDocument } from '../../lib/quoteAcceptanceDocument.js';
import { waslSignService, WaslSignServiceError } from '../../lib/waslSign.js';
import { notifyOrgStaff } from '../notifications/notifications.js';
import {
  ApprovalPolicyService,
  meetsOrExceedsRequirement,
} from '../approval-policy/approval-policy.service.js';
import {
  canReleaseWorkOrder,
  deriveWorkflowResult,
  mapWaslSignEventToSignatureStatus,
} from '../quotes/workflow-result.js';
import type {
  CreateVariationInput,
  PresignVariationAttachmentInput,
  RegisterVariationAttachmentInput,
  RejectVariationInput,
  SetVariationWorkflowModeInput,
} from './work-order-variations.schemas.js';

const variationInclude = {
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
  approvedByUser: { select: { id: true, firstName: true, lastName: true } },
} as const;

type VariationWithInclude = Prisma.WorkOrderVariationGetPayload<{
  include: typeof variationInclude;
}>;

/** A variation's signature workflow needs a real work order — its
 * property/space/contractor context for the document, and to know who to
 * notify — matching how quotes.service.ts's startSignatureWorkflow needs
 * quote.workOrder. */
const workOrderContextInclude = {
  property: { select: { id: true, name: true } },
  space: { select: { id: true, name: true } },
  contractor: { select: { id: true, name: true, email: true } },
} as const;
type WorkOrderWithContext = Prisma.WorkOrderGetPayload<{ include: typeof workOrderContextInclude }>;

const ATTACHMENT_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Additional scope/cost discovered once a Work Order is already authorised
 * — never mutates WorkOrder.estimatedCost (the original selected quote's
 * amount) or the selected ContractorQuote itself, both of which must stay
 * intact historical evidence of what was actually approved. The
 * authorised total is always computed at read time from the original
 * amount plus every APPROVED variation — never stored, so it can never
 * drift out of sync with the variations that make it up.
 *
 * A variation now goes through the SAME Approval & Acceptance concepts and
 * execution infrastructure as a ContractorQuote — workflowMode/
 * approvalStatus/signatureStatus, the native approval step, and the real
 * WaslSign integration — mirroring quotes.service.ts's setWorkflowMode /
 * approve / reject / startSignatureWorkflow / handleWaslSignCallback
 * structure closely on purpose. It reuses (never duplicates):
 * ApprovalPolicyService.meetsOrExceedsRequirement, workflow-result.ts's
 * deriveWorkflowResult/canReleaseWorkOrder/mapWaslSignEventToSignatureStatus,
 * and the single WaslSignService/WaslSignWebhookEvent integration.
 * `status` only ever becomes APPROVED (and therefore counts toward
 * approvedVariationsTotal) once deriveWorkflowResult says COMPLETED — see
 * `finalizeIfComplete` below, the one place that decision is made.
 */
export class WorkOrderVariationsService {
  private readonly approvalPolicy: ApprovalPolicyService;

  constructor(private readonly prisma: PrismaClient) {
    this.approvalPolicy = new ApprovalPolicyService(prisma);
  }

  private async getOwnedWorkOrder(organisationId: string, workOrderId: string) {
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, organisationId },
    });
    if (!workOrder) {
      throw new NotFoundError('Work order not found');
    }
    return workOrder;
  }

  private async getOwnedWorkOrderWithContext(
    organisationId: string,
    workOrderId: string,
  ): Promise<WorkOrderWithContext> {
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, organisationId },
      include: workOrderContextInclude,
    });
    if (!workOrder) {
      throw new NotFoundError('Work order not found');
    }
    return workOrder;
  }

  private async getOwnedVariation(organisationId: string, variationId: string) {
    const variation = await this.prisma.workOrderVariation.findFirst({
      where: { id: variationId, organisationId },
      include: variationInclude,
    });
    if (!variation) {
      throw new NotFoundError('Variation not found');
    }
    return variation;
  }

  async list(organisationId: string, workOrderId: string) {
    await this.getOwnedWorkOrder(organisationId, workOrderId);
    return this.prisma.workOrderVariation.findMany({
      where: { organisationId, workOrderId },
      orderBy: { createdAt: 'asc' },
      include: variationInclude,
    });
  }

  /** Original amount + every APPROVED variation — PENDING_APPROVAL,
   * REJECTED, and CANCELLED variations never count. "APPROVED" now means
   * every Approval & Acceptance gate this variation's workflow implies has
   * actually completed (see finalizeIfComplete) — never merely that
   * someone clicked a button. Computed fresh on every call, never cached
   * on the Work Order itself. */
  async getCommercialSummary(organisationId: string, workOrderId: string) {
    const workOrder = await this.getOwnedWorkOrder(organisationId, workOrderId);
    const variations = await this.prisma.workOrderVariation.findMany({
      where: { organisationId, workOrderId },
    });

    const approved = variations.filter((v) => v.status === 'APPROVED');
    const pending = variations.filter((v) => v.status === 'PENDING_APPROVAL');
    // Summed as Prisma.Decimal (exact base-10 arithmetic, same engine the
    // DB column itself uses), never plain JS numbers — this feeds
    // WaslSign's legal/commercial variation documents, where a
    // floating-point drift of even a single cent (e.g. 0.1 + 0.2 !==
    // 0.3 in IEEE-754) is a real correctness defect, not cosmetic.
    // Converted to Number only at the very end, to keep this endpoint's
    // existing numeric response contract unchanged.
    const approvedTotalDecimal = approved.reduce(
      (sum, v) => sum.plus(v.amountDelta),
      new Prisma.Decimal(0),
    );
    const pendingTotalDecimal = pending.reduce(
      (sum, v) => sum.plus(v.amountDelta),
      new Prisma.Decimal(0),
    );
    const originalAmountDecimal =
      workOrder.estimatedCost != null
        ? new Prisma.Decimal(workOrder.estimatedCost)
        : new Prisma.Decimal(0);
    const authorisedTotalDecimal = originalAmountDecimal.plus(approvedTotalDecimal);

    return {
      currencyCode: workOrder.currencyCode,
      originalAmount: originalAmountDecimal.toNumber(),
      approvedVariationsTotal: approvedTotalDecimal.toNumber(),
      pendingVariationsTotal: pendingTotalDecimal.toNumber(),
      authorisedTotal: authorisedTotalDecimal.toNumber(),
      approvedVariationCount: approved.length,
      pendingVariationCount: pending.length,
    };
  }

  async create(
    organisationId: string,
    actorUserId: string,
    workOrderId: string,
    input: CreateVariationInput,
  ) {
    const workOrder = await this.getOwnedWorkOrder(organisationId, workOrderId);
    if (workOrder.status === 'CANCELLED') {
      throw new ConflictError('Cannot record a variation on a cancelled work order');
    }

    // Evaluated on the variation's own amount, not the resulting authorised
    // total (original + approved variations + this one) — the simplest
    // defensible choice given nothing in the existing business model
    // establishes which one is correct; see the M12 Approval Policy
    // milestone's final report for the reasoning and how a future
    // total-based policy dimension could be added here without a rewrite.
    // A deduction (negative amountDelta) is evaluated on its magnitude —
    // a large credit is as significant a commercial change as an equally
    // large increase.
    const resolution = await this.approvalPolicy.resolve(
      organisationId,
      Math.abs(input.amountDelta),
      workOrder.currencyCode,
    );

    return this.prisma.$transaction(async (tx) => {
      const variation = await withPublicReference('VAR', (publicReference) =>
        tx.workOrderVariation.create({
          data: {
            organisationId,
            publicReference,
            workOrderId,
            description: input.description,
            amountDelta: input.amountDelta,
            currencyCode: workOrder.currencyCode,
            status: 'PENDING_APPROVAL',
            recordedByUserId: actorUserId,
            requiredWorkflowMode: resolution.workflowMode,
            approvalPolicySnapshot: resolution as unknown as Prisma.InputJsonValue,
            // A pre-selected suggestion only, exactly like
            // QuotesService.create — nothing starts until a manager
            // confirms via setWorkflowMode. Null (no policy/currency
            // mismatch) means no suggestion; the manager must choose
            // explicitly, never silently NONE (see setWorkflowMode/
            // approve's null handling).
            workflowMode: resolution.workflowMode ?? undefined,
          },
          include: variationInclude,
        }),
      );

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_VARIATION_CREATED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Variation recorded: ${workOrder.title}`,
        description: `${input.amountDelta >= 0 ? '+' : ''}${input.amountDelta} ${workOrder.currencyCode} · ${input.description}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `Variation needs approval: ${workOrder.title}`,
          body: `${input.amountDelta >= 0 ? '+' : ''}${input.amountDelta} ${workOrder.currencyCode}`,
          entityType: 'WorkOrder',
          entityId: workOrder.id,
        },
        { excludeUserId: actorUserId },
      );

      return variation;
    });
  }

  /**
   * Sets the business-process choice for this variation — same shape and
   * same rules as QuotesService.setWorkflowMode: a manager may add more
   * control than the organisation's policy requires, never less (enforced
   * via the shared meetsOrExceedsRequirement, not a second copy of that
   * rule). Unlike a quote, confirming NONE here does not itself finalise
   * anything — the existing `approve` action stays the one place a
   * variation actually becomes APPROVED, so NONE just clears the way for
   * a plain approve() call with no further ceremony (see approve's own
   * doc comment).
   */
  async setWorkflowMode(
    organisationId: string,
    actorUserId: string,
    variationId: string,
    input: SetVariationWorkflowModeInput,
  ) {
    const variation = await this.getOwnedVariation(organisationId, variationId);
    if (variation.status !== 'PENDING_APPROVAL') {
      throw new ConflictError(
        `Cannot change the workflow for a variation already ${variation.status.toLowerCase()}`,
      );
    }
    if (
      variation.requiredWorkflowMode &&
      !meetsOrExceedsRequirement(input.workflowMode, variation.requiredWorkflowMode)
    ) {
      const requiredLabel = variation.requiredWorkflowMode.toLowerCase().replace(/_/g, ' ');
      throw new ConflictError(
        `Organisation policy requires at least "${requiredLabel}" for this amount — a manager cannot select a weaker workflow. An OWNER or ADMIN can change the organisation's Approval & Acceptance policy if this requirement is wrong.`,
      );
    }

    if (input.workflowMode === 'SIGNATURE_ONLY') {
      const workOrder = await this.getOwnedWorkOrderWithContext(
        organisationId,
        variation.workOrderId,
      );
      return this.startSignatureWorkflow(
        organisationId,
        actorUserId,
        variation,
        workOrder,
        'SIGNATURE_ONLY',
      );
    }

    const workOrder = await this.getOwnedWorkOrder(organisationId, variation.workOrderId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrderVariation.update({
        where: { id: variationId },
        data: {
          workflowMode: input.workflowMode,
          approvalStatus:
            input.workflowMode === 'APPROVAL_ONLY' ||
            input.workflowMode === 'APPROVAL_THEN_SIGNATURE'
              ? 'PENDING'
              : undefined,
        },
        include: variationInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_VARIATION_WORKFLOW_CONFIRMED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Variation workflow confirmed: ${workOrder.title}`,
        description: `${input.workflowMode.toLowerCase().replace(/_/g, ' ')} · ${variation.description}`,
      });

      return updated;
    });
  }

  /**
   * The one entry point that can move a variation to APPROVED — either
   * directly (NONE, or APPROVAL_ONLY once its gate passes) or by starting
   * the signature phase that will eventually do so
   * (APPROVAL_THEN_SIGNATURE). Mirrors QuotesService.approve's shape
   * closely. "Do not introduce unnecessary ceremony" for NONE (per the
   * spec): if workflowMode was never explicitly confirmed but the policy
   * already resolved NONE, this call itself both confirms it and approves
   * it — no separate setWorkflowMode round-trip required. But a NONE
   * *requirement* is never assumed merely because nothing was confirmed —
   * requiredWorkflowMode being null (no policy, or a currency mismatch at
   * creation) always forces an explicit setWorkflowMode call first, so a
   * manager can never silently skip a workflow whose absence was never
   * actually established as safe.
   */
  async approve(organisationId: string, actorUserId: string, variationId: string) {
    const variation = await this.getOwnedVariation(organisationId, variationId);
    if (variation.status !== 'PENDING_APPROVAL') {
      throw new ConflictError(`Cannot approve a variation in ${variation.status} status`);
    }
    const workOrder = await this.getOwnedWorkOrder(organisationId, variation.workOrderId);

    let workflowMode = variation.workflowMode;
    if (!workflowMode) {
      if (variation.requiredWorkflowMode !== 'NONE') {
        throw new ConflictError(
          'Confirm the required Approval & Acceptance workflow for this variation before approving it.',
        );
      }
      workflowMode = 'NONE';
    }

    if (workflowMode === 'NONE') {
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.workOrderVariation.update({
          where: { id: variationId },
          data: {
            workflowMode: 'NONE',
            status: 'APPROVED',
            approvedByUserId: actorUserId,
            approvedAt: new Date(),
          },
          include: variationInclude,
        });
        await this.recordApprovedAndAuthorised(tx, organisationId, actorUserId, workOrder, updated);
        return updated;
      });
    }

    if (workflowMode !== 'APPROVAL_ONLY' && workflowMode !== 'APPROVAL_THEN_SIGNATURE') {
      throw new ConflictError('This variation does not require approval');
    }
    if (variation.approvalStatus !== 'PENDING') {
      throw new ConflictError(
        `Approval already ${variation.approvalStatus?.toLowerCase() ?? 'resolved'}`,
      );
    }

    const approved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrderVariation.update({
        where: { id: variationId },
        data: { approvalStatus: 'APPROVED', approvedByUserId: actorUserId, approvedAt: new Date() },
        include: variationInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_VARIATION_APPROVED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Variation approval completed: ${workOrder.title}`,
        description: `${Number(updated.amountDelta) >= 0 ? '+' : ''}${updated.amountDelta} ${updated.currencyCode}`,
      });

      return updated;
    });

    const result = deriveWorkflowResult(workflowMode, 'APPROVED', approved.signatureStatus);
    if (canReleaseWorkOrder(result)) {
      // APPROVAL_ONLY — the approval gate was the only one required.
      return this.prisma.$transaction(async (tx) => {
        const finalised = await tx.workOrderVariation.update({
          where: { id: variationId },
          data: { status: 'APPROVED' },
          include: variationInclude,
        });
        await this.recordAuthorised(tx, organisationId, workOrder, finalised, actorUserId);
        return finalised;
      });
    }

    // APPROVAL_THEN_SIGNATURE — signature only ever starts here, once
    // approval has actually passed, never before and never if rejected.
    const workOrderWithContext = await this.getOwnedWorkOrderWithContext(
      organisationId,
      variation.workOrderId,
    );
    return this.startSignatureWorkflow(
      organisationId,
      actorUserId,
      approved,
      workOrderWithContext,
      'APPROVAL_THEN_SIGNATURE',
    );
  }

  async reject(
    organisationId: string,
    actorUserId: string,
    variationId: string,
    input: RejectVariationInput,
  ) {
    const variation = await this.getOwnedVariation(organisationId, variationId);
    if (variation.status !== 'PENDING_APPROVAL') {
      throw new ConflictError(`Cannot reject a variation in ${variation.status} status`);
    }
    const workOrder = await this.getOwnedWorkOrder(organisationId, variation.workOrderId);

    // Rejecting the approval gate (if one was ever confirmed/started) —
    // signature never starts on a rejected variation, mirroring
    // QuotesService.reject exactly. A variation with no confirmed
    // workflow yet (workflowMode null) can still be rejected outright —
    // there is no approval-gate state to invalidate first.
    if (
      variation.workflowMode === 'APPROVAL_ONLY' ||
      variation.workflowMode === 'APPROVAL_THEN_SIGNATURE'
    ) {
      if (variation.approvalStatus !== 'PENDING') {
        throw new ConflictError(
          `Approval already ${variation.approvalStatus?.toLowerCase() ?? 'resolved'}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrderVariation.update({
        where: { id: variationId },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          approvalStatus:
            variation.workflowMode === 'APPROVAL_ONLY' ||
            variation.workflowMode === 'APPROVAL_THEN_SIGNATURE'
              ? 'REJECTED'
              : undefined,
        },
        include: variationInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_VARIATION_REJECTED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Variation rejected: ${workOrder.title}`,
        description: input.reason ?? variation.description,
      });

      return updated;
    });
  }

  /** Withdrawing a variation entered by mistake — distinct from rejection,
   * which is a reviewer's decision. Either the person who recorded it or
   * anyone with work_orders.manage may cancel a still-pending one (the
   * route-level capability check covers authorisation; this just enforces
   * the status guard). */
  async cancel(organisationId: string, actorUserId: string, variationId: string) {
    const variation = await this.getOwnedVariation(organisationId, variationId);
    if (variation.status !== 'PENDING_APPROVAL') {
      throw new ConflictError(`Cannot cancel a variation in ${variation.status} status`);
    }
    const workOrder = await this.getOwnedWorkOrder(organisationId, variation.workOrderId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrderVariation.update({
        where: { id: variationId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
        include: variationInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_VARIATION_CANCELLED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Variation cancelled: ${workOrder.title}`,
        description: variation.description,
      });

      return updated;
    });
  }

  /** Shared finalisation for the two "gate just passed, nothing else
   * required" cases (NONE, and — via recordAuthorised below —
   * APPROVAL_ONLY once approved). Records both the gate-level event and
   * the one canonical "this now counts toward the authorised total" event
   * in the same transaction. */
  private async recordApprovedAndAuthorised(
    tx: Prisma.TransactionClient,
    organisationId: string,
    actorUserId: string | null,
    workOrder: { propertyId: string; spaceId: string | null; title: string; id: string },
    variation: VariationWithInclude,
  ) {
    await recordActivity(tx, {
      organisationId,
      propertyId: workOrder.propertyId,
      spaceId: workOrder.spaceId,
      actorUserId,
      eventType: 'WORK_ORDER_VARIATION_APPROVED',
      entityType: 'WorkOrder',
      entityId: workOrder.id,
      title: `Variation approved: ${workOrder.title}`,
      description: `${Number(variation.amountDelta) >= 0 ? '+' : ''}${variation.amountDelta} ${variation.currencyCode}`,
    });
    await this.recordAuthorised(tx, organisationId, workOrder, variation, actorUserId);
  }

  private async recordAuthorised(
    tx: Prisma.TransactionClient,
    organisationId: string,
    workOrder: { propertyId: string; spaceId: string | null; title: string; id: string },
    variation: VariationWithInclude,
    actorUserId: string | null = null,
  ) {
    await recordActivity(tx, {
      organisationId,
      propertyId: workOrder.propertyId,
      spaceId: workOrder.spaceId,
      actorUserId,
      eventType: 'WORK_ORDER_VARIATION_AUTHORISED',
      entityType: 'WorkOrder',
      entityId: workOrder.id,
      title: `Variation authorised: ${workOrder.title}`,
      description: `${Number(variation.amountDelta) >= 0 ? '+' : ''}${variation.amountDelta} ${variation.currencyCode} now included in the authorised total`,
    });
    await notifyOrgStaff(
      tx,
      organisationId,
      {
        title: `Variation authorised for ${workOrder.title}`,
        body: `${Number(variation.amountDelta) >= 0 ? '+' : ''}${variation.amountDelta} ${variation.currencyCode}`,
        entityType: 'WorkOrder',
        entityId: workOrder.id,
      },
      actorUserId ? { excludeUserId: actorUserId } : {},
    );
  }

  private async startSignatureWorkflow(
    organisationId: string,
    actorUserId: string,
    variation: VariationWithInclude,
    workOrder: WorkOrderWithContext,
    workflowMode: 'SIGNATURE_ONLY' | 'APPROVAL_THEN_SIGNATURE',
  ) {
    if (!waslSignService.isConfigured()) {
      throw new ConflictError(
        'Signature workflow is not available: WaslSign integration is not configured',
      );
    }
    if (!workOrder.contractor) {
      throw new ConflictError(
        'Cannot start a signature workflow: this work order has no contractor assigned',
      );
    }

    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });
    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: actorUserId } });
    let waslSignOrganisationId = organisation.waslSignOrganisationId;

    // The proposed new authorised total shown on the document — every
    // previously APPROVED variation plus this one, on top of the
    // original amount. Excludes this variation itself from "previously
    // approved" (it isn't yet), and excludes every other still-pending or
    // rejected/cancelled variation, exactly like getCommercialSummary.
    const summary = await this.getCommercialSummary(organisationId, workOrder.id);

    try {
      if (!waslSignOrganisationId) {
        waslSignOrganisationId = await waslSignService.provisionOrganisation(
          organisationId,
          organisation.name,
        );
        await this.prisma.organisation.update({
          where: { id: organisationId },
          data: { waslSignOrganisationId },
        });
      }

      const { bytes: documentBytes, signatureFields } = await generateVariationAcceptanceDocument({
        organisationName: organisation.name,
        propertyName: workOrder.property.name,
        spaceName: workOrder.space?.name,
        workOrderTitle: workOrder.title,
        workOrderId: workOrder.id,
        contractorName: workOrder.contractor.name,
        originalAmount: summary.originalAmount.toFixed(2),
        previouslyApprovedVariationsTotal: summary.approvedVariationsTotal.toFixed(2),
        variationDescription: variation.description,
        variationAmount: variation.amountDelta.toString(),
        currencyCode: variation.currencyCode,
      });

      const result = await waslSignService.createAgreementWorkflow({
        waslSignOrganisationId,
        sourceEntityId: variation.id,
        title: `${workOrder.title} — Variation Acceptance`,
        description: variation.description,
        signers: [
          {
            name: `${actor.firstName} ${actor.lastName} (Authorised Signatory)`,
            email: actor.email,
            signingOrder: 1,
            field: signatureFields[0],
          },
          {
            name: workOrder.contractor.name,
            email: workOrder.contractor.email,
            signingOrder: 2,
            field: signatureFields[1],
          },
        ],
        documentBase64: Buffer.from(documentBytes).toString('base64'),
        senderDisplayName: organisation.name,
      });

      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.workOrderVariation.update({
          where: { id: variation.id },
          data: {
            workflowMode,
            signatureStatus: 'PENDING',
            waslSignAgreementId: result.agreementId,
            waslSignStatus: result.status,
          },
          include: variationInclude,
        });

        await recordActivity(tx, {
          organisationId,
          propertyId: workOrder.propertyId,
          spaceId: workOrder.spaceId,
          actorUserId,
          eventType: 'WORK_ORDER_VARIATION_SIGNATURE_STARTED',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          title: `Variation signing started: ${workOrder.title}`,
          description: `${Number(variation.amountDelta) >= 0 ? '+' : ''}${variation.amountDelta} ${variation.currencyCode} · ${workOrder.contractor?.name ?? ''}`,
        });

        return updated;
      });
    } catch (err) {
      if (err instanceof WaslSignServiceError) {
        logger.error(
          { err, variationId: variation.id },
          'Failed to start WaslSign workflow for a variation',
        );
        throw new ConflictError(`Could not start the signature workflow: ${err.message}`);
      }
      throw err;
    }
  }

  /** Idempotent — a duplicate eventId is a guaranteed no-op, same ledger
   * (WaslSignWebhookEvent, globally unique eventId) and same pattern as
   * QuotesService.handleWaslSignCallback. Only ever invoked by the
   * integrations/waslsign controller once it has determined — via a
   * persisted-identifier lookup, not string parsing — that this
   * sourceEntityId belongs to a WorkOrderVariation rather than a
   * ContractorQuote. */
  async handleWaslSignCallback(payload: {
    eventId: string;
    eventType: string;
    sourceEntityId: string;
    waslSignAgreementId: string;
  }) {
    try {
      await this.prisma.waslSignWebhookEvent.create({
        data: { eventId: payload.eventId, payload: payload as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        logger.info({ eventId: payload.eventId }, 'Duplicate WaslSign webhook event ignored');
        return { handled: false, reason: 'duplicate' as const };
      }
      throw err;
    }

    const variation = await this.prisma.workOrderVariation.findFirst({
      where: { id: payload.sourceEntityId },
      include: variationInclude,
    });
    if (!variation) {
      logger.warn({ payload }, 'WaslSign callback for unknown variation — ignored');
      return { handled: false, reason: 'unknown_variation' as const };
    }
    if (variation.waslSignAgreementId !== payload.waslSignAgreementId) {
      logger.warn(
        { payload, variationId: variation.id },
        'WaslSign callback agreement id mismatch — ignored',
      );
      return { handled: false, reason: 'agreement_mismatch' as const };
    }
    if (variation.status !== 'PENDING_APPROVAL') {
      // Terminal variation (already authorised some other way, rejected,
      // or cancelled) — a late/out-of-order callback must never rewrite
      // history or double-count anything.
      logger.info(
        { variationId: variation.id, status: variation.status },
        'WaslSign callback for an already-terminal variation — ignored',
      );
      return { handled: false, reason: 'already_terminal' as const };
    }

    const signatureStatus = mapWaslSignEventToSignatureStatus(payload.eventType);
    if (!signatureStatus) {
      return { handled: false, reason: 'unrecognised_event' as const };
    }
    if (variation.signatureStatus === signatureStatus) {
      // Nothing actually changed (e.g. WaslSign's SIGNED and
      // WORKFLOW_COMPLETED events both land here) — no duplicate activity,
      // no double-counting.
      return { handled: true as const, reason: 'no_change' as const };
    }

    const workOrder = await this.getOwnedWorkOrder(variation.organisationId, variation.workOrderId);
    const result = deriveWorkflowResult(
      variation.workflowMode,
      variation.approvalStatus,
      signatureStatus,
    );
    const nowCompleting = canReleaseWorkOrder(result) && signatureStatus === 'SIGNED';
    const nowFailing = signatureStatus === 'DECLINED' || signatureStatus === 'EXPIRED';

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrderVariation.update({
        where: { id: variation.id },
        data: {
          signatureStatus,
          waslSignStatus: payload.eventType,
          signedAt: nowCompleting ? new Date() : variation.signedAt,
          status: nowCompleting ? 'APPROVED' : variation.status,
        },
        include: variationInclude,
      });

      if (nowCompleting) {
        await recordActivity(tx, {
          organisationId: variation.organisationId,
          propertyId: workOrder.propertyId,
          spaceId: workOrder.spaceId,
          eventType: 'WORK_ORDER_VARIATION_SIGNED',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          title: `Variation signed: ${workOrder.title}`,
          description: `${Number(updated.amountDelta) >= 0 ? '+' : ''}${updated.amountDelta} ${updated.currencyCode}`,
        });
        await this.recordAuthorised(tx, variation.organisationId, workOrder, updated);
      } else if (nowFailing) {
        await recordActivity(tx, {
          organisationId: variation.organisationId,
          propertyId: workOrder.propertyId,
          spaceId: workOrder.spaceId,
          eventType: 'WORK_ORDER_VARIATION_SIGNATURE_FAILED',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          title: `Variation signature ${signatureStatus.toLowerCase()}: ${workOrder.title}`,
          description: variation.description,
        });
        await notifyOrgStaff(tx, variation.organisationId, {
          title: `Signature ${signatureStatus.toLowerCase()} for a variation on ${workOrder.title}`,
          body: variation.description,
          entityType: 'WorkOrder',
          entityId: workOrder.id,
        });
      }
      // PENDING / PARTIALLY_SIGNED / CANCELLED — silent status update only,
      // avoiding noisy activity for a step that isn't meaningfully
      // decided yet (see the ActivityEvent doc comment's "avoid noisy
      // events" guidance).
    });

    return { handled: true as const };
  }

  async presignAttachment(
    organisationId: string,
    variationId: string,
    input: PresignVariationAttachmentInput,
  ) {
    await this.getOwnedVariation(organisationId, variationId);
    const maxBytes = env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB * 1024 * 1024;
    if (input.fileSize > maxBytes) {
      throw new ConflictError(
        `The document must be ${env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB} MB or smaller`,
      );
    }
    const extension = ATTACHMENT_EXTENSION[input.contentType];
    const storageKey = `organisations/${organisationId}/work-order-variations/${variationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
    const uploadUrl = await presignPut(storageKey, input.contentType);
    return { storageKey, uploadUrl, fileName: input.fileName, contentType: input.contentType };
  }

  async registerAttachment(
    organisationId: string,
    actorUserId: string,
    variationId: string,
    input: RegisterVariationAttachmentInput,
  ) {
    await this.getOwnedVariation(organisationId, variationId);
    const prefix = `organisations/${organisationId}/work-order-variations/${variationId}/`;
    if (!input.storageKey.startsWith(prefix)) {
      throw new ForbiddenError('This document was not issued for this variation');
    }
    return this.prisma.workOrderVariationAttachment.create({
      data: {
        organisationId,
        workOrderVariationId: variationId,
        uploadedByUserId: actorUserId,
        storageKey: input.storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        fileSize: input.fileSize,
      },
    });
  }

  async listAttachments(organisationId: string, variationId: string) {
    await this.getOwnedVariation(organisationId, variationId);
    const attachments = await this.prisma.workOrderVariationAttachment.findMany({
      where: { workOrderVariationId: variationId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(
      attachments.map(async (a) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        fileSize: a.fileSize,
        createdAt: a.createdAt,
        url: await presignGet(a.storageKey),
      })),
    );
  }
}
