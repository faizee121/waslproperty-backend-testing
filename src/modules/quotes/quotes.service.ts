import type { Prisma, PrismaClient } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import { logger } from '../../lib/logger.js';
import { generateQuoteAcceptanceDocument } from '../../lib/quoteAcceptanceDocument.js';
import { waslSignService, WaslSignServiceError } from '../../lib/waslSign.js';
import { notifyOrgStaff } from '../notifications/notifications.js';
import { WorkOrdersService } from '../work-orders/work-orders.service.js';
import {
  ApprovalPolicyService,
  meetsOrExceedsRequirement,
} from '../approval-policy/approval-policy.service.js';
import { mapWaslSignEventToSignatureStatus } from './workflow-result.js';
import type {
  CreateQuoteInput,
  RejectQuoteInput,
  SetWorkflowModeInput,
  SubmitQuoteInput,
} from './quotes.schemas.js';

const quoteInclude = {
  contractor: { select: { id: true, name: true, companyName: true, email: true } },
  workOrder: {
    select: {
      id: true,
      title: true,
      organisationId: true,
      maintenanceRequestId: true,
      property: { select: { id: true, name: true } },
      space: { select: { id: true, name: true } },
    },
  },
  quoteRound: {
    select: {
      id: true,
      title: true,
      property: { select: { id: true, name: true } },
      space: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ContractorQuoteInclude;

type QuoteWithInclude = Prisma.ContractorQuoteGetPayload<{ include: typeof quoteInclude }>;

/** Property/space/title/entity context for activity + notifications —
 * derived from whichever of workOrder/quoteRound this quote actually has.
 * Before award (RFQ path), only quoteRound exists; from award onward, both
 * do (and workOrder is what everything after award should describe). */
function quoteContext(quote: QuoteWithInclude) {
  if (quote.workOrder) {
    return {
      propertyId: quote.workOrder.property.id,
      spaceId: quote.workOrder.space?.id ?? null,
      title: quote.workOrder.title,
      entityType: 'WorkOrder' as const,
      entityId: quote.workOrder.id,
    };
  }
  if (quote.quoteRound) {
    return {
      propertyId: quote.quoteRound.property.id,
      spaceId: quote.quoteRound.space?.id ?? null,
      title: quote.quoteRound.title,
      entityType: 'QuoteRound' as const,
      entityId: quote.quoteRound.id,
    };
  }
  throw new ConflictError('This quote is not linked to a work order or quote round');
}
/** Once M11's RFQ path can leave workOrderId null until award, every method
 * below that manages the approval/signature workflow (which only ever
 * makes sense once a quote governs a real Work Order) needs this
 * confirmed first — a quote still awaiting award has no workflow to speak
 * of yet. Narrows `quote.workOrder` to non-null for the rest of the
 * calling function. */
type AwardedQuote = QuoteWithInclude & {
  workOrder: NonNullable<QuoteWithInclude['workOrder']>;
  amount: NonNullable<QuoteWithInclude['amount']>;
};
function assertAwarded(quote: QuoteWithInclude): asserts quote is AwardedQuote {
  if (!quote.workOrder) {
    throw new ConflictError('This quote has not been awarded to a work order yet');
  }
  if (quote.amount == null) {
    throw new ConflictError('This quote has no amount yet');
  }
}

export class QuotesService {
  private readonly workOrdersService: WorkOrdersService;
  private readonly approvalPolicy: ApprovalPolicyService;

  constructor(private readonly prisma: PrismaClient) {
    this.workOrdersService = new WorkOrdersService(prisma);
    this.approvalPolicy = new ApprovalPolicyService(prisma);
  }

  /**
   * The DRAFT → READY step isn't really a manager decision — it's just
   * reflecting that the required workflow finished. Advance it the moment
   * that becomes true, rather than making the manager click "Update status"
   * purely to acknowledge something that already happened. Scheduling,
   * starting, and completing stay genuinely manual (see M7's Work Order
   * Release rule). Best-effort: if the work order already moved on or isn't
   * actually eligible yet, this silently no-ops rather than surfacing an
   * error the caller has no reason to handle.
   */
  private async maybeReleaseWorkOrder(
    organisationId: string,
    workOrderId: string,
    actorUserId: string | null,
  ) {
    try {
      await this.workOrdersService.updateStatus(organisationId, actorUserId, workOrderId, {
        status: 'READY',
      });
    } catch (err) {
      if (err instanceof ConflictError) return;
      throw err;
    }
  }

  private async getOwnedQuote(organisationId: string, quoteId: string) {
    const quote = await this.prisma.contractorQuote.findFirst({
      where: { id: quoteId, organisationId },
      include: quoteInclude,
    });
    if (!quote) {
      throw new NotFoundError('Quote not found');
    }
    return quote;
  }

  async create(organisationId: string, input: CreateQuoteInput) {
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: input.workOrderId, organisationId },
    });
    if (!workOrder) {
      throw new NotFoundError('Work order not found');
    }

    const contractor = await this.prisma.contractor.findFirst({
      where: { id: input.contractorId, organisationId, status: 'ACTIVE' },
    });
    if (!contractor) {
      throw new NotFoundError('Contractor not found');
    }

    // Copied at creation, never re-derived later — see
    // ContractorQuote.currencyCode doc comment in schema.prisma. An
    // explicit input.currencyCode (a contractor quoting in a different
    // currency than the org default) always wins over the organisation's.
    const currencyCode =
      input.currencyCode ??
      (
        await this.prisma.organisation.findUniqueOrThrow({
          where: { id: organisationId },
          select: { currencyCode: true },
        })
      ).currencyCode;

    // Direct Work has no separate "award" moment — recording this quote IS
    // the commercial commitment becoming real, so this is where the
    // organisation's Approval & Acceptance policy is resolved (see
    // ApprovalPolicyService's doc comment for why this is one of exactly
    // three resolution points).
    const resolution = await this.approvalPolicy.resolve(
      organisationId,
      input.amount,
      currencyCode,
    );

    return this.prisma.contractorQuote.create({
      data: {
        organisationId,
        workOrderId: input.workOrderId,
        contractorId: input.contractorId,
        amount: input.amount,
        currencyCode,
        description: input.description,
        status: 'REQUESTED',
        // A pre-selected suggestion only — nothing starts until a manager
        // confirms via setWorkflowMode, exactly as before. Null (no
        // policy/currency mismatch) means no suggestion at all; the
        // manager must choose explicitly, never silently NONE.
        workflowMode: resolution.workflowMode ?? undefined,
        requiredWorkflowMode: resolution.workflowMode,
        approvalPolicySnapshot: resolution as unknown as Prisma.InputJsonValue,
      },
      include: quoteInclude,
    });
  }

  async getById(organisationId: string, quoteId: string) {
    return this.getOwnedQuote(organisationId, quoteId);
  }

  /** actorUserId is null when a contractor submits through their own
   * secure RFQ link — there is no WaslProp user acting. A manager entering
   * a quote on a contractor's behalf (or revising a Direct Work quote)
   * supplies their own id. */
  async submit(
    organisationId: string,
    actorUserId: string | null,
    quoteId: string,
    input: SubmitQuoteInput,
  ) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    if (quote.status !== 'REQUESTED') {
      throw new ConflictError(`Cannot submit a quote in ${quote.status} status`);
    }
    // A quote created straight against a Work Order (Direct Work) already
    // has its amount from creation; an RFQ-invited quote has none until
    // this exact moment, so one is required here for that case.
    if (quote.amount == null && input.amount == null) {
      throw new ConflictError('An amount is required to submit this quote');
    }

    const ctx = quoteContext(quote);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.contractorQuote.update({
        where: { id: quoteId },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          amount: input.amount ?? undefined,
          description: input.description ?? undefined,
          proposedStartAt: input.proposedStartAt ?? undefined,
          estimatedDuration: input.estimatedDuration ?? undefined,
          inclusions: input.inclusions ?? undefined,
          exclusions: input.exclusions ?? undefined,
          warrantyInfo: input.warrantyInfo ?? undefined,
          // No workflowMode resolution here — receiving a quote (even a
          // manager typing one in) is not the same as it being selected.
          // The Approval & Acceptance policy is resolved once, at the
          // moment a quote actually becomes the selected/awarded one — see
          // QuoteRoundsService.award for the RFQ path and create() above
          // for Direct Work.
        },
        include: quoteInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: ctx.propertyId,
        spaceId: ctx.spaceId,
        actorUserId,
        eventType: 'QUOTE_SUBMITTED',
        entityType: ctx.entityType,
        entityId: ctx.entityId,
        title: `Quote submitted by ${quote.contractor.name}`,
        description: `${updated.amount} ${updated.currencyCode} · ${ctx.title}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `Quote submitted for ${ctx.title}`,
          body: `${quote.contractor.name} · needs review`,
          entityType: ctx.entityType,
          entityId: ctx.entityId,
        },
        actorUserId ? { excludeUserId: actorUserId } : {},
      );

      return updated;
    });
  }

  /** The contractor explicitly declines to quote — RFQ path only (a Direct
   * Work quote was never "invited" in this sense). actorUserId is null
   * when the contractor declines through their own secure link; a manager
   * recording a decline they received by phone/email supplies their own
   * id. */
  async decline(organisationId: string, actorUserId: string | null, quoteId: string) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    if (quote.status !== 'REQUESTED') {
      throw new ConflictError(`Cannot decline a quote in ${quote.status} status`);
    }
    const ctx = quoteContext(quote);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.contractorQuote.update({
        where: { id: quoteId },
        data: { status: 'DECLINED', declinedAt: new Date() },
        include: quoteInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: ctx.propertyId,
        spaceId: ctx.spaceId,
        actorUserId,
        eventType: 'QUOTE_DECLINED',
        entityType: ctx.entityType,
        entityId: ctx.entityId,
        title: `${quote.contractor.name} declined to quote`,
        description: ctx.title,
      });

      await notifyOrgStaff(tx, organisationId, {
        title: `${quote.contractor.name} declined to quote`,
        body: ctx.title,
        entityType: ctx.entityType,
        entityId: ctx.entityId,
      });

      return updated;
    });
  }

  /** The contractor withdraws a quote they already submitted, before it's
   * been selected. Once a round is AWARDED its losing quotes become
   * NOT_SELECTED instead — withdrawal is only ever a contractor's own
   * choice, not an outcome of losing. */
  async withdraw(organisationId: string, actorUserId: string | null, quoteId: string) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    if (quote.status !== 'SUBMITTED') {
      throw new ConflictError(`Cannot withdraw a quote in ${quote.status} status`);
    }
    const ctx = quoteContext(quote);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.contractorQuote.update({
        where: { id: quoteId },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
        include: quoteInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: ctx.propertyId,
        spaceId: ctx.spaceId,
        actorUserId,
        eventType: 'QUOTE_ROUND_QUOTE_WITHDRAWN',
        entityType: ctx.entityType,
        entityId: ctx.entityId,
        title: `${quote.contractor.name} withdrew their quote`,
        description: ctx.title,
      });

      await notifyOrgStaff(tx, organisationId, {
        title: `${quote.contractor.name} withdrew their quote`,
        body: ctx.title,
        entityType: ctx.entityType,
        entityId: ctx.entityId,
      });

      return updated;
    });
  }

  /**
   * Sets the business-process choice for this quote. APPROVAL_ONLY just
   * opens the native approval step (no WaslSign call at all). SIGNATURE_ONLY
   * starts the WaslSign signature workflow immediately. APPROVAL_THEN_SIGNATURE
   * opens the native approval step only — signature starts automatically
   * once (and only if) that approval passes, see approve().
   */
  async setWorkflowMode(
    organisationId: string,
    actorUserId: string,
    quoteId: string,
    input: SetWorkflowModeInput,
  ) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    assertAwarded(quote);
    if (quote.status === 'APPROVED' || quote.status === 'REJECTED') {
      throw new ConflictError(
        `Cannot change the workflow for a quote already ${quote.status.toLowerCase()}`,
      );
    }
    // A manager may add MORE control than the organisation's policy
    // requires (e.g. choosing APPROVAL_THEN_SIGNATURE where only
    // APPROVAL_ONLY was required), but may never weaken it — if that
    // policy is wrong for this organisation, an OWNER/ADMIN should change
    // the policy itself, not quietly bypass it quote by quote. No floor is
    // enforced when requiredWorkflowMode is null (no policy was configured
    // or the currency didn't match at resolution time).
    if (
      quote.requiredWorkflowMode &&
      !meetsOrExceedsRequirement(input.workflowMode, quote.requiredWorkflowMode)
    ) {
      const requiredLabel = quote.requiredWorkflowMode.toLowerCase().replace(/_/g, ' ');
      throw new ConflictError(
        `Organisation policy requires at least "${requiredLabel}" for this amount — a manager cannot select a weaker workflow. An OWNER or ADMIN can change the organisation's Approval & Acceptance policy if this requirement is wrong.`,
      );
    }

    if (input.workflowMode === 'NONE') {
      // Nothing to review or sign — confirming NONE is itself the
      // decision, so this quote is immediately as final as APPROVAL_ONLY's
      // approve() leaves one, not left in an in-progress review state.
      return this.prisma.contractorQuote.update({
        where: { id: quoteId },
        data: { workflowMode: 'NONE', status: 'APPROVED' },
        include: quoteInclude,
      });
    }

    if (
      input.workflowMode === 'APPROVAL_ONLY' ||
      input.workflowMode === 'APPROVAL_THEN_SIGNATURE'
    ) {
      return this.prisma.contractorQuote.update({
        where: { id: quoteId },
        data: {
          workflowMode: input.workflowMode,
          approvalStatus: 'PENDING',
          status: 'UNDER_REVIEW',
        },
        include: quoteInclude,
      });
    }

    // SIGNATURE_ONLY — start the WaslSign workflow right away.
    return this.startSignatureWorkflow(organisationId, actorUserId, quote, input.workflowMode);
  }

  async approve(organisationId: string, actorUserId: string, quoteId: string) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    assertAwarded(quote);
    if (
      quote.workflowMode !== 'APPROVAL_ONLY' &&
      quote.workflowMode !== 'APPROVAL_THEN_SIGNATURE'
    ) {
      throw new ConflictError('This quote does not require approval');
    }
    if (quote.approvalStatus !== 'PENDING') {
      throw new ConflictError(
        `Approval already ${quote.approvalStatus?.toLowerCase() ?? 'resolved'}`,
      );
    }

    const approved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.contractorQuote.update({
        where: { id: quoteId },
        data: {
          approvalStatus: 'APPROVED',
          approvedByUserId: actorUserId,
          approvedAt: new Date(),
          status: quote.workflowMode === 'APPROVAL_ONLY' ? 'APPROVED' : 'UNDER_REVIEW',
        },
        include: quoteInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: quote.workOrder.property.id,
        spaceId: quote.workOrder.space?.id ?? null,
        actorUserId,
        eventType: 'QUOTE_APPROVED',
        entityType: 'WorkOrder',
        entityId: quote.workOrder.id,
        title: `Quote approved: ${quote.workOrder.title}`,
        description: `${quote.amount} ${quote.currencyCode} · ${quote.contractor.name}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `Quote approved for ${quote.workOrder.title}`,
          body: quote.contractor.name,
          entityType: 'WorkOrder',
          entityId: quote.workOrder.id,
        },
        { excludeUserId: actorUserId },
      );

      return updated;
    });

    if (quote.workflowMode === 'APPROVAL_ONLY') {
      await this.maybeReleaseWorkOrder(organisationId, quote.workOrder.id, actorUserId);
      return approved;
    }

    // APPROVAL_THEN_SIGNATURE — the signature phase only ever starts here,
    // never before approval, and never if approval was rejected instead.
    // Still the same quote assertAwarded already vetted, just re-fetched
    // via the update above — re-assert rather than trust the Prisma return
    // type, which doesn't know that.
    assertAwarded(approved);
    return this.startSignatureWorkflow(
      organisationId,
      actorUserId,
      approved,
      'APPROVAL_THEN_SIGNATURE',
    );
  }

  async reject(
    organisationId: string,
    actorUserId: string,
    quoteId: string,
    input: RejectQuoteInput,
  ) {
    const quote = await this.getOwnedQuote(organisationId, quoteId);
    assertAwarded(quote);
    if (
      quote.workflowMode !== 'APPROVAL_ONLY' &&
      quote.workflowMode !== 'APPROVAL_THEN_SIGNATURE'
    ) {
      throw new ConflictError('This quote does not require approval');
    }
    if (quote.approvalStatus !== 'PENDING') {
      throw new ConflictError(
        `Approval already ${quote.approvalStatus?.toLowerCase() ?? 'resolved'}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.contractorQuote.update({
        where: { id: quoteId },
        data: { approvalStatus: 'REJECTED', rejectedAt: new Date(), status: 'REJECTED' },
        include: quoteInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: quote.workOrder.property.id,
        spaceId: quote.workOrder.space?.id ?? null,
        actorUserId,
        eventType: 'QUOTE_REJECTED',
        entityType: 'WorkOrder',
        entityId: quote.workOrder.id,
        title: `Quote rejected: ${quote.workOrder.title}`,
        description:
          input.reason ?? `${quote.amount} ${quote.currencyCode} · ${quote.contractor.name}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `Quote rejected for ${quote.workOrder.title}`,
          body: quote.contractor.name,
          entityType: 'WorkOrder',
          entityId: quote.workOrder.id,
        },
        { excludeUserId: actorUserId },
      );

      return updated;
    });
  }

  private async startSignatureWorkflow(
    organisationId: string,
    actorUserId: string,
    quote: AwardedQuote,
    workflowMode: 'SIGNATURE_ONLY' | 'APPROVAL_THEN_SIGNATURE',
  ) {
    if (!waslSignService.isConfigured()) {
      throw new ConflictError(
        'Signature workflow is not available: WaslSign integration is not configured',
      );
    }

    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });
    // The authorised signatory is the real manager who confirmed this
    // workflow — a synthetic address here would mean WaslSign faithfully
    // emails a signing link to an inbox that can never exist.
    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: actorUserId } });
    let waslSignOrganisationId = organisation.waslSignOrganisationId;

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

      const { bytes: documentBytes, signatureFields } = await generateQuoteAcceptanceDocument({
        organisationName: organisation.name,
        propertyName: quote.workOrder.property.name,
        spaceName: quote.workOrder.space?.name,
        workOrderTitle: quote.workOrder.title,
        workOrderId: quote.workOrder.id,
        maintenanceRequestId: quote.workOrder.maintenanceRequestId,
        contractorName: quote.contractor.name,
        scopeOfWork: quote.description ?? quote.workOrder.title,
        amount: quote.amount.toString(),
        currencyCode: quote.currencyCode,
      });

      const result = await waslSignService.createAgreementWorkflow({
        waslSignOrganisationId,
        sourceEntityId: quote.id,
        title: `${quote.workOrder.title} — Acceptance`,
        description: quote.description ?? undefined,
        signers: [
          {
            name: `${actor.firstName} ${actor.lastName} (Authorised Signatory)`,
            email: actor.email,
            signingOrder: 1,
            field: signatureFields[0],
          },
          {
            name: quote.contractor.name,
            email: quote.contractor.email,
            signingOrder: 2,
            field: signatureFields[1],
          },
        ],
        documentBase64: Buffer.from(documentBytes).toString('base64'),
        senderDisplayName: organisation.name,
      });

      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.contractorQuote.update({
          where: { id: quote.id },
          data: {
            workflowMode,
            signatureStatus: 'PENDING',
            waslSignAgreementId: result.agreementId,
            waslSignStatus: result.status,
            status: 'UNDER_REVIEW',
          },
          include: quoteInclude,
        });

        await recordActivity(tx, {
          organisationId,
          propertyId: quote.workOrder.property.id,
          spaceId: quote.workOrder.space?.id ?? null,
          actorUserId,
          eventType: 'QUOTE_SIGNING_STARTED',
          entityType: 'WorkOrder',
          entityId: quote.workOrder.id,
          title: `Signing started: ${quote.workOrder.title}`,
          description: `${quote.amount} ${quote.currencyCode} · ${quote.contractor.name}`,
        });

        return updated;
      });
    } catch (err) {
      if (err instanceof WaslSignServiceError) {
        logger.error({ err, quoteId: quote.id }, 'Failed to start WaslSign workflow');
        throw new ConflictError(`Could not start the signature workflow: ${err.message}`);
      }
      throw err;
    }
  }

  /** Idempotent — a duplicate eventId is a guaranteed no-op (see the unique constraint on WaslSignWebhookEvent.eventId). */
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

    const quote = await this.prisma.contractorQuote.findFirst({
      where: { id: payload.sourceEntityId },
      include: quoteInclude,
    });
    if (!quote) {
      logger.warn({ payload }, 'WaslSign callback for unknown quote — ignored');
      return { handled: false, reason: 'unknown_quote' as const };
    }
    if (quote.waslSignAgreementId !== payload.waslSignAgreementId) {
      logger.warn(
        { payload, quoteId: quote.id },
        'WaslSign callback agreement id mismatch — ignored',
      );
      return { handled: false, reason: 'agreement_mismatch' as const };
    }
    // A quote only ever gets a waslSignAgreementId via startSignatureWorkflow,
    // which only ever runs on an AwardedQuote — so this always holds in
    // practice; asserted here purely so TypeScript knows it too.
    assertAwarded(quote);

    const signatureStatus = mapWaslSignEventToSignatureStatus(payload.eventType);
    if (!signatureStatus) {
      return { handled: false, reason: 'unrecognised_event' as const };
    }
    if (quote.signatureStatus === signatureStatus) {
      // Nothing actually changed (e.g. WaslSign's SIGNED and
      // WORKFLOW_COMPLETED events both land here) — no duplicate activity.
      return { handled: true as const, reason: 'no_change' as const };
    }

    const nowCompleting = signatureStatus === 'SIGNED';
    await this.prisma.$transaction(async (tx) => {
      await tx.contractorQuote.update({
        where: { id: quote.id },
        data: {
          signatureStatus,
          signedAt: nowCompleting ? new Date() : quote.signedAt,
          status: nowCompleting ? 'APPROVED' : quote.status,
        },
      });

      await recordActivity(tx, {
        organisationId: quote.organisationId,
        propertyId: quote.workOrder.property.id,
        spaceId: quote.workOrder.space?.id ?? null,
        eventType: nowCompleting ? 'QUOTE_SIGNED' : 'QUOTE_SUBMITTED',
        entityType: 'WorkOrder',
        entityId: quote.workOrder.id,
        title: nowCompleting
          ? `Agreement signed: ${quote.workOrder.title}`
          : `Signature update: ${quote.workOrder.title}`,
        description: `Status: ${signatureStatus}`,
      });

      if (nowCompleting) {
        await notifyOrgStaff(tx, quote.organisationId, {
          title: `Signature completed for ${quote.workOrder.title}`,
          body: quote.contractor.name,
          entityType: 'WorkOrder',
          entityId: quote.workOrder.id,
        });
      }
    });

    if (nowCompleting) {
      // No human actor for a webhook-driven completion — signer identities
      // are recorded in WaslSign's own audit trail, not duplicated here.
      await this.maybeReleaseWorkOrder(quote.organisationId, quote.workOrder.id, null);
    }

    return { handled: true as const };
  }
}
