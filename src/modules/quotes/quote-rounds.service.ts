import type { Prisma, PrismaClient } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError.js';
import { env } from '../../config/env.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { logger } from '../../lib/logger.js';
import { emailService } from '../../lib/email.js';
import { generateRfqToken, hashRfqToken, rfqTokenExpiresAt } from '../../lib/tokens.js';
import { presignGet, presignPut } from '../../lib/s3.js';
import { notifyOrgStaff } from '../notifications/notifications.js';
import { ContractorEligibilityService } from '../contractors/compliance/eligibility.service.js';
import { ApprovalPolicyService } from '../approval-policy/approval-policy.service.js';
import { QuotesService } from './quotes.service.js';
import { renderRfqAwardedEmail, renderRfqInvitationEmail } from './quote-rounds.email.js';
import type {
  CreateQuoteRoundInput,
  PresignQuoteAttachmentInput,
  RfqPublicSubmitInput,
} from './quote-rounds.schemas.js';

const roundInclude = {
  property: { select: { id: true, publicReference: true, name: true } },
  space: { select: { id: true, publicReference: true, name: true } },
  maintenanceRequest: { select: { id: true, publicReference: true, title: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  invitations: {
    include: {
      contractor: { select: { id: true, name: true, companyName: true, email: true } },
      quote: true,
    },
  },
} satisfies Prisma.QuoteRoundInclude;

const ATTACHMENT_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The RFQ/procurement side of M11 — everything from "define a scope and
 * invite contractors to quote" through to "award the round," at which
 * point a real Work Order is created and the existing QuotesService's
 * approval/signature machinery takes over completely unchanged. Direct
 * Work (no round at all) never touches this service — it keeps using
 * WorkOrdersService/QuotesService exactly as before M11.
 */
export class QuoteRoundsService {
  private readonly quotesService: QuotesService;
  private readonly eligibility: ContractorEligibilityService;
  private readonly approvalPolicy: ApprovalPolicyService;

  constructor(private readonly prisma: PrismaClient) {
    this.quotesService = new QuotesService(prisma);
    this.eligibility = new ContractorEligibilityService(prisma);
    this.approvalPolicy = new ApprovalPolicyService(prisma);
  }

  private async getOwnedRound(organisationId: string, quoteRoundId: string) {
    const round = await this.prisma.quoteRound.findFirst({
      where: { id: quoteRoundId, organisationId },
      include: roundInclude,
    });
    if (!round) {
      throw new NotFoundError('Quote round not found');
    }
    return round;
  }

  async create(organisationId: string, actorUserId: string, input: CreateQuoteRoundInput) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: input.maintenanceRequestId, organisationId },
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    const currencyCode =
      input.currencyCode ??
      (
        await this.prisma.organisation.findUniqueOrThrow({
          where: { id: organisationId },
          select: { currencyCode: true },
        })
      ).currencyCode;

    const round = await this.prisma.$transaction(async (tx) => {
      // Lock the MaintenanceRequest row for the rest of this transaction
      // before re-checking either conflict condition below — the exact
      // same lock WorkOrdersService.create() takes on the same row, so
      // Postgres serialises any two concurrent create() calls (from
      // either service) for this maintenance request rather than letting
      // both pass a pre-transaction existence check against not-yet-
      // committed state and both succeed.
      await tx.$queryRaw`SELECT id FROM maintenance_requests WHERE id = ${request.id} FOR UPDATE`;

      const existingRound = await tx.quoteRound.findFirst({
        where: { maintenanceRequestId: request.id, status: { in: ['DRAFT', 'OPEN'] } },
      });
      if (existingRound) {
        throw new ConflictError('This maintenance request already has an active quote round');
      }
      const existingWorkOrder = await tx.workOrder.findFirst({
        where: { maintenanceRequestId: request.id, status: { not: 'CANCELLED' } },
      });
      if (existingWorkOrder) {
        throw new ConflictError('This maintenance request already has a work order');
      }

      const created = await withPublicReference('RFQ', (publicReference) =>
        tx.quoteRound.create({
          data: {
            organisationId,
            publicReference,
            propertyId: request.propertyId,
            spaceId: request.spaceId,
            maintenanceRequestId: request.id,
            category: request.category,
            title: input.title,
            scopeDescription: input.scopeDescription,
            priority: request.priority,
            accessInstructions: input.accessInstructions,
            desiredStartAt: input.desiredStartAt,
            dueAt: input.dueAt,
            currencyCode,
            status: 'OPEN',
            createdByUserId: actorUserId,
          },
          include: roundInclude,
        }),
      );

      await tx.maintenanceRequest.update({
        where: { id: request.id },
        data: { procurementPath: 'REQUEST_QUOTES' },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: request.propertyId,
        spaceId: request.spaceId,
        actorUserId,
        eventType: 'QUOTE_ROUND_CREATED',
        entityType: 'QuoteRound',
        entityId: created.id,
        title: `Quotes requested: ${created.title}`,
        description: `${request.category} · ${created.currencyCode}`,
      });

      return created;
    });

    return this.inviteContractors(organisationId, actorUserId, round.id, input.contractorIds);
  }

  async inviteContractors(
    organisationId: string,
    actorUserId: string,
    quoteRoundId: string,
    contractorIds: string[],
  ) {
    const round = await this.getOwnedRound(organisationId, quoteRoundId);
    if (round.status !== 'OPEN' && round.status !== 'DRAFT') {
      throw new ConflictError(`Cannot invite contractors to a ${round.status.toLowerCase()} round`);
    }

    const contractors = await this.prisma.contractor.findMany({
      where: { id: { in: contractorIds }, organisationId, status: 'ACTIVE' },
    });
    if (contractors.length !== contractorIds.length) {
      throw new NotFoundError('One or more contractors were not found');
    }
    const alreadyInvited = new Set(round.invitations.map((i) => i.contractorId));
    const toInvite = contractors.filter((c) => !alreadyInvited.has(c.id));

    for (const contractor of toInvite) {
      const rawToken = generateRfqToken();
      const tokenHash = hashRfqToken(rawToken);
      const tokenExpiresAt = rfqTokenExpiresAt();

      await this.prisma.$transaction(async (tx) => {
        const quote = await tx.contractorQuote.create({
          data: {
            organisationId,
            quoteRoundId: round.id,
            contractorId: contractor.id,
            currencyCode: round.currencyCode,
            status: 'REQUESTED',
          },
        });
        await tx.quoteRoundInvitation.create({
          data: {
            organisationId,
            quoteRoundId: round.id,
            contractorId: contractor.id,
            quoteId: quote.id,
            tokenHash,
            tokenExpiresAt,
            invitedByUserId: actorUserId,
          },
        });
        await recordActivity(tx, {
          organisationId,
          propertyId: round.propertyId,
          spaceId: round.spaceId,
          actorUserId,
          eventType: 'QUOTE_ROUND_CONTRACTOR_INVITED',
          entityType: 'QuoteRound',
          entityId: round.id,
          title: `${contractor.name} invited to quote`,
          description: round.title,
        });
      });

      await this.sendInvitationEmail(round, contractor, rawToken);
    }

    return this.getOwnedRound(organisationId, quoteRoundId);
  }

  private async sendInvitationEmail(
    round: Awaited<ReturnType<typeof this.getOwnedRound>>,
    contractor: { name: string; email: string },
    rawToken: string,
  ) {
    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: round.organisationId },
      select: { name: true },
    });
    const responseUrl = `${env.FRONTEND_URL}/rfq/${rawToken}`;
    const { subject, html, text } = renderRfqInvitationEmail({
      contractorName: contractor.name,
      organisationName: organisation.name,
      propertyName: round.property.name,
      spaceName: round.space?.name ?? null,
      title: round.title,
      category: round.category,
      dueAt: round.dueAt,
      responseUrl,
    });
    try {
      await emailService.send({ to: contractor.email, subject, html, text });
    } catch (error) {
      // Never let a transient mail-provider failure roll back the
      // invitation itself — the invitation row is the recovery path.
      logger.error({ err: error }, 'Failed to send RFQ invitation email');
    }
  }

  async getById(organisationId: string, quoteRoundId: string) {
    const round = await this.getOwnedRound(organisationId, quoteRoundId);
    return this.withEligibility(organisationId, round);
  }

  async findByMaintenanceRequestId(organisationId: string, maintenanceRequestId: string) {
    const round = await this.prisma.quoteRound.findFirst({
      where: { organisationId, maintenanceRequestId, status: { not: 'CANCELLED' } },
      include: roundInclude,
      orderBy: { createdAt: 'desc' },
    });
    if (!round) return null;
    return this.withEligibility(organisationId, round);
  }

  /** Attaches each invited contractor's current real eligibility for this
   * round's trade — reusing ContractorEligibilityService exactly as the
   * Work Order assignment panel does, never a second calculation. Being
   * shown here is informational only; the actual gate is award(). Also
   * attaches the originating maintenance request's own photos/documents —
   * deliberately referenced live rather than copied, since an uploaded
   * file is already immutable and carries none of the "silent edit" risk
   * that the scope-snapshot requirement (title/description/etc, copied at
   * round-creation time) exists to guard against. */
  private async withEligibility(
    organisationId: string,
    round: Awaited<ReturnType<typeof this.getOwnedRound>>,
  ) {
    const [invitationsWithEligibility, attachments] = await Promise.all([
      Promise.all(
        round.invitations.map(async (invitation) => ({
          ...invitation,
          eligibility: await this.eligibility.evaluate(
            organisationId,
            invitation.contractorId,
            round.category,
          ),
        })),
      ),
      this.getRequestAttachments(organisationId, round.maintenanceRequestId),
    ]);
    return { ...round, invitations: invitationsWithEligibility, attachments };
  }

  /** Presigned GET links for the originating maintenance request's own
   * attachments — QuoteRound has no attachment model of its own by
   * design (see withEligibility's doc comment). */
  private async getRequestAttachments(organisationId: string, maintenanceRequestId: string) {
    const attachments = await this.prisma.maintenanceRequestAttachment.findMany({
      where: { organisationId, maintenanceRequestId },
      orderBy: { createdAt: 'asc' },
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

  /** Contractors relevant for inviting to quote on a maintenance request —
   * same shape and same ContractorEligibilityService call as
   * WorkOrdersService.listContractorEligibility, just resolved from a
   * maintenance request's own category instead of an existing work
   * order's, since at this point (before a round exists) there is no work
   * order to hang the lookup off yet. */
  async listContractorEligibilityForRequest(organisationId: string, maintenanceRequestId: string) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: maintenanceRequestId, organisationId },
      select: { category: true },
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    const contractors = await this.prisma.contractor.findMany({
      where: { organisationId, status: 'ACTIVE' },
      select: { id: true, name: true, companyName: true, email: true },
      orderBy: { name: 'asc' },
    });

    const results = await Promise.all(
      contractors.map(async (contractor) => ({
        contractor,
        eligibility: await this.eligibility.evaluate(
          organisationId,
          contractor.id,
          request.category,
        ),
      })),
    );

    return { category: request.category, contractors: results };
  }

  async cancel(organisationId: string, actorUserId: string, quoteRoundId: string, reason?: string) {
    const round = await this.getOwnedRound(organisationId, quoteRoundId);
    if (round.status === 'AWARDED' || round.status === 'CANCELLED') {
      throw new ConflictError(
        `Cannot cancel a round that is already ${round.status.toLowerCase()}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.quoteRound.update({
        where: { id: quoteRoundId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
        include: roundInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: round.propertyId,
        spaceId: round.spaceId,
        actorUserId,
        eventType: 'QUOTE_ROUND_CANCELLED',
        entityType: 'QuoteRound',
        entityId: round.id,
        title: `Quote round cancelled: ${round.title}`,
        description: reason ?? undefined,
      });

      return updated;
    });
  }

  /**
   * The critical enforcement point: selecting a quote re-evaluates the
   * contractor's compliance right now, never trusting whatever their
   * status was when they submitted — a contractor genuinely eligible on
   * Monday can be genuinely ineligible by Friday (an insurance policy
   * lapsed), and this is the last moment WaslProp can catch that before
   * real authorised work exists. A BLOCK_ASSIGNMENT failure stops the
   * award outright, with the exact same structured reasons Work Order
   * assignment already returns — this is the same
   * ContractorEligibilityService call, not a second implementation of the
   * same rule.
   */
  async award(
    organisationId: string,
    actorUserId: string,
    quoteRoundId: string,
    quoteId: string,
    note?: string,
  ) {
    const round = await this.getOwnedRound(organisationId, quoteRoundId);
    if (round.status !== 'OPEN') {
      throw new ConflictError(`Cannot award a ${round.status.toLowerCase()} round`);
    }
    const invitation = round.invitations.find((i) => i.quoteId === quoteId);
    if (!invitation) {
      throw new NotFoundError('Quote not found in this round');
    }
    const quote = invitation.quote;
    if (quote.status !== 'SUBMITTED') {
      throw new ConflictError(`Cannot award a quote in ${quote.status} status`);
    }
    if (quote.amount == null) {
      throw new ConflictError('This quote has no amount');
    }

    const eligibility = await this.eligibility.evaluate(
      organisationId,
      quote.contractorId,
      round.category,
    );
    if (!eligibility.eligible) {
      throw new ForbiddenError(
        `${invitation.contractor.name} is not eligible for this work`,
        eligibility,
      );
    }

    // Award is the moment this quote actually becomes the selected
    // commercial commitment — exactly the point QuotesService.create
    // resolves it for Direct Work at, so this is the RFQ path's one
    // resolution point (receiving quotes during comparison never resolves
    // or starts anything — see QuotesService.submit).
    const resolution = await this.approvalPolicy.resolve(
      organisationId,
      quote.amount.toString(),
      quote.currencyCode,
    );

    // A concurrent second award attempt on the same round must never
    // produce two winners — the round's own status transition
    // (OPEN -> AWARDED) inside this same transaction, guarded by the
    // OPEN check re-applied against the database row, is what prevents
    // that: Postgres serialises the two UPDATE ... WHERE status = 'OPEN'
    // statements, and the loser affects zero rows.
    const result = await this.prisma.$transaction(async (tx) => {
      const roundUpdateResult = await tx.quoteRound.updateMany({
        where: { id: round.id, status: 'OPEN' },
        data: { status: 'AWARDED', awardedQuoteId: quote.id, awardedAt: new Date() },
      });
      if (roundUpdateResult.count === 0) {
        throw new ConflictError('This round has already been awarded');
      }

      const workOrder = await withPublicReference('WO', (publicReference) =>
        tx.workOrder.create({
          data: {
            organisationId,
            publicReference,
            propertyId: round.propertyId,
            spaceId: round.spaceId,
            maintenanceRequestId: round.maintenanceRequestId,
            title: round.title,
            description: round.scopeDescription,
            priority: round.priority,
            status: 'DRAFT',
            createdByUserId: actorUserId,
            currencyCode: quote.currencyCode,
            estimatedCost: quote.amount,
            contractorId: quote.contractorId,
            selectedQuoteId: quote.id,
            quoteRoundId: round.id,
          },
        }),
      );

      const awardedQuote = await tx.contractorQuote.update({
        where: { id: quote.id },
        data: {
          workOrderId: workOrder.id,
          selectedAt: new Date(),
          selectedByUserId: actorUserId,
          description: note ? `${quote.description ?? ''}\n\n${note}`.trim() : quote.description,
          workflowMode: resolution.workflowMode ?? undefined,
          requiredWorkflowMode: resolution.workflowMode,
          approvalPolicySnapshot: resolution as unknown as Prisma.InputJsonValue,
        },
        include: { contractor: { select: { id: true, name: true, email: true } } },
      });

      const losingQuoteIds = round.invitations
        .map((i) => i.quoteId)
        .filter((id) => id !== quote.id);
      if (losingQuoteIds.length > 0) {
        await tx.contractorQuote.updateMany({
          where: { id: { in: losingQuoteIds }, status: 'SUBMITTED' },
          data: { status: 'NOT_SELECTED' },
        });
      }

      await recordActivity(tx, {
        organisationId,
        propertyId: round.propertyId,
        spaceId: round.spaceId,
        actorUserId,
        eventType: 'QUOTE_SELECTED',
        entityType: 'ContractorQuote',
        entityId: quote.id,
        title: `Quote selected: ${invitation.contractor.name}`,
        description: `${quote.amount} ${quote.currencyCode} · ${round.title}`,
      });
      await recordActivity(tx, {
        organisationId,
        propertyId: round.propertyId,
        spaceId: round.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_AUTHORISED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Work order authorised: ${workOrder.title}`,
        description: `${invitation.contractor.name} · ${quote.amount} ${quote.currencyCode}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `Work order authorised for ${round.title}`,
          body: `${invitation.contractor.name} · ${quote.amount} ${quote.currencyCode}`,
          entityType: 'WorkOrder',
          entityId: workOrder.id,
        },
        { excludeUserId: actorUserId },
      );

      return { workOrder, quote: awardedQuote };
    });

    // Best-effort contractor notifications — never block the award itself.
    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { name: true },
    });
    await this.notifyAwardOutcome(organisation.name, round, quote.id, result.quote.contractor);

    return result;
  }

  private async notifyAwardOutcome(
    organisationName: string,
    round: Awaited<ReturnType<typeof this.getOwnedRound>>,
    winningQuoteId: string,
    winner: { name: string; email: string },
  ) {
    const send = async (contractor: { name: string; email: string }, awarded: boolean) => {
      const { subject, html, text } = renderRfqAwardedEmail({
        contractorName: contractor.name,
        organisationName,
        title: round.title,
        awarded,
      });
      try {
        await emailService.send({ to: contractor.email, subject, html, text });
      } catch (error) {
        logger.error({ err: error }, 'Failed to send award-outcome email');
      }
    };

    await send(winner, true);
    for (const invitation of round.invitations) {
      if (invitation.quoteId === winningQuoteId) continue;
      if (invitation.quote.status !== 'SUBMITTED' && invitation.quote.status !== 'NOT_SELECTED') {
        continue;
      }
      await send(invitation.contractor, false);
    }
  }

  // --- Public (token-based) contractor response ---

  private async getInvitationByRawToken(rawToken: string) {
    const tokenHash = hashRfqToken(rawToken);
    const invitation = await this.prisma.quoteRoundInvitation.findUnique({
      where: { tokenHash },
      include: {
        quoteRound: { include: roundInclude },
        contractor: { select: { id: true, name: true, companyName: true, email: true } },
        quote: true,
      },
    });
    if (!invitation || invitation.revokedAt) {
      throw new NotFoundError('This link is invalid or has been revoked');
    }
    if (invitation.tokenExpiresAt.getTime() < Date.now()) {
      throw new NotFoundError('This link has expired');
    }
    return invitation;
  }

  /** Everything the public response page needs — deliberately minimal:
   * the scope this contractor was actually asked to quote, their own
   * quote's current state, and nothing about any other invited
   * contractor. */
  async getPublicInvitation(rawToken: string) {
    const invitation = await this.getInvitationByRawToken(rawToken);
    const round = invitation.quoteRound;
    const [organisation, attachments] = await Promise.all([
      this.prisma.organisation.findUniqueOrThrow({
        where: { id: round.organisationId },
        select: { name: true },
      }),
      this.getRequestAttachments(round.organisationId, round.maintenanceRequestId),
    ]);
    return {
      organisationName: organisation.name,
      round: {
        id: round.id,
        title: round.title,
        scopeDescription: round.scopeDescription,
        category: round.category,
        priority: round.priority,
        accessInstructions: round.accessInstructions,
        desiredStartAt: round.desiredStartAt,
        dueAt: round.dueAt,
        currencyCode: round.currencyCode,
        status: round.status,
        property: round.property,
        space: round.space,
        attachments,
      },
      contractor: invitation.contractor,
      quote: invitation.quote,
    };
  }

  async publicSubmit(rawToken: string, input: RfqPublicSubmitInput) {
    const invitation = await this.getInvitationByRawToken(rawToken);
    if (invitation.quoteRound.status !== 'OPEN') {
      throw new ConflictError('This request is no longer accepting quotes');
    }
    const updated = await this.quotesService.submit(
      invitation.organisationId,
      null,
      invitation.quoteId,
      input,
    );
    await this.prisma.contractorQuote.update({
      where: { id: invitation.quoteId },
      data: { source: 'CONTRACTOR_PORTAL' },
    });
    return updated;
  }

  async publicDecline(rawToken: string) {
    const invitation = await this.getInvitationByRawToken(rawToken);
    if (invitation.quoteRound.status !== 'OPEN') {
      throw new ConflictError('This request is no longer accepting responses');
    }
    return this.quotesService.decline(invitation.organisationId, null, invitation.quoteId);
  }

  async presignPublicAttachment(rawToken: string, input: PresignQuoteAttachmentInput) {
    const invitation = await this.getInvitationByRawToken(rawToken);
    const maxBytes = env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB * 1024 * 1024;
    if (input.fileSize > maxBytes) {
      throw new ConflictError(
        `The document must be ${env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB} MB or smaller`,
      );
    }
    const extension = ATTACHMENT_EXTENSION[input.contentType];
    const storageKey = `organisations/${invitation.organisationId}/quotes/${invitation.quoteId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
    const uploadUrl = await presignPut(storageKey, input.contentType);
    return { storageKey, uploadUrl, fileName: input.fileName, contentType: input.contentType };
  }

  async registerPublicAttachment(
    rawToken: string,
    input: { storageKey: string; fileName: string; contentType: string; fileSize: number },
  ) {
    const invitation = await this.getInvitationByRawToken(rawToken);
    const prefix = `organisations/${invitation.organisationId}/quotes/${invitation.quoteId}/`;
    if (!input.storageKey.startsWith(prefix)) {
      throw new ForbiddenError('This document was not issued for this quote');
    }
    return this.prisma.contractorQuoteAttachment.create({
      data: {
        organisationId: invitation.organisationId,
        contractorQuoteId: invitation.quoteId,
        storageKey: input.storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        fileSize: input.fileSize,
      },
    });
  }

  /** Authenticated (manager) counterpart of presignPublicAttachment — used
   * when staff attach a document to a manually-recorded quote. */
  async presignAttachment(
    organisationId: string,
    quoteId: string,
    input: PresignQuoteAttachmentInput,
  ) {
    const quote = await this.prisma.contractorQuote.findFirst({
      where: { id: quoteId, organisationId },
    });
    if (!quote) throw new NotFoundError('Quote not found');
    const maxBytes = env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB * 1024 * 1024;
    if (input.fileSize > maxBytes) {
      throw new ConflictError(
        `The document must be ${env.CREDENTIAL_DOCUMENT_MAX_SIZE_MB} MB or smaller`,
      );
    }
    const extension = ATTACHMENT_EXTENSION[input.contentType];
    const storageKey = `organisations/${organisationId}/quotes/${quoteId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
    const uploadUrl = await presignPut(storageKey, input.contentType);
    return { storageKey, uploadUrl, fileName: input.fileName, contentType: input.contentType };
  }

  async registerAttachment(
    organisationId: string,
    actorUserId: string,
    quoteId: string,
    input: { storageKey: string; fileName: string; contentType: string; fileSize: number },
  ) {
    const quote = await this.prisma.contractorQuote.findFirst({
      where: { id: quoteId, organisationId },
    });
    if (!quote) throw new NotFoundError('Quote not found');
    const prefix = `organisations/${organisationId}/quotes/${quoteId}/`;
    if (!input.storageKey.startsWith(prefix)) {
      throw new ForbiddenError('This document was not issued for this quote');
    }
    return this.prisma.contractorQuoteAttachment.create({
      data: {
        organisationId,
        contractorQuoteId: quoteId,
        uploadedByUserId: actorUserId,
        storageKey: input.storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        fileSize: input.fileSize,
      },
    });
  }

  async listAttachments(organisationId: string, quoteId: string) {
    const quote = await this.prisma.contractorQuote.findFirst({
      where: { id: quoteId, organisationId },
    });
    if (!quote) throw new NotFoundError('Quote not found');
    const attachments = await this.prisma.contractorQuoteAttachment.findMany({
      where: { contractorQuoteId: quoteId },
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
