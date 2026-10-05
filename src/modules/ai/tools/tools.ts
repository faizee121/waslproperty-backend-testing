import type { MaintenanceCategory, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../../errors/AppError.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { ApprovalPolicyService } from '../../approval-policy/approval-policy.service.js';
import { ContractorEligibilityService } from '../../contractors/compliance/eligibility.service.js';
import { QuoteRoundsService } from '../../quotes/quote-rounds.service.js';
import { StrataService } from '../../strata/strata.service.js';
import { WorkOrderVariationsService } from '../../work-orders/work-order-variations.service.js';
import type { AiResource } from '../ai.types.js';
import type { AiToolDefinition } from './tool-types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Re-derives a maintenance request's owning propertyId (organisation-
 * scoped) — the only authorization-bearing lookup any resolvePropertyId
 * below performs; never trusts a propertyId argument directly. */
async function resolveMaintenanceRequestProperty(
  prisma: PrismaClient,
  organisationId: string,
  maintenanceRequestId: string,
): Promise<string | undefined> {
  const request = await prisma.maintenanceRequest.findFirst({
    where: { id: maintenanceRequestId, organisationId },
    select: { propertyId: true },
  });
  return request?.propertyId;
}

async function resolveWorkOrderProperty(
  prisma: PrismaClient,
  organisationId: string,
  workOrderId: string,
): Promise<string | undefined> {
  const workOrder = await prisma.workOrder.findFirst({
    where: { id: workOrderId, organisationId },
    select: { propertyId: true },
  });
  return workOrder?.propertyId;
}

async function resolveQuoteProperty(
  prisma: PrismaClient,
  organisationId: string,
  contractorQuoteId: string,
): Promise<string | undefined> {
  const quote = await prisma.contractorQuote.findFirst({
    where: { id: contractorQuoteId, organisationId },
    select: {
      workOrder: { select: { propertyId: true } },
      quoteRound: { select: { propertyId: true } },
    },
  });
  return quote?.workOrder?.propertyId ?? quote?.quoteRound?.propertyId;
}

async function resolvePropertyDirect(
  prisma: PrismaClient,
  organisationId: string,
  propertyId: string,
): Promise<string | undefined> {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, organisationId },
    select: { id: true },
  });
  return property?.id;
}

function ageInHours(from: Date, to: Date = new Date()): number {
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60));
}

// ---------------------------------------------------------------------------
// 1. get_maintenance_request_context
// ---------------------------------------------------------------------------

const maintenanceRequestContextParams = z.object({
  maintenanceRequestId: z.string().min(1),
});

const getMaintenanceRequestContext: AiToolDefinition<
  z.infer<typeof maintenanceRequestContextParams>,
  unknown
> = {
  name: 'get_maintenance_request_context',
  description:
    "The full operational context for one maintenance request: its core details, property/space, reporter, the linked work order (if any) and its status/contractor/cost, the linked quote round summary (if any), how long it has been open, and how many similar requests exist for the same property recently. Use this as the starting point for 'why is this request delayed / what is the status of this issue' style investigations.",
  parameters: maintenanceRequestContextParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { maintenanceRequestId: { type: 'string', description: 'Maintenance request id' } },
    required: ['maintenanceRequestId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'maintenance.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveMaintenanceRequestProperty(prisma, organisationId, params.maintenanceRequestId),
  handler: async (prisma, organisationId, _auth, params) => {
    const request = await prisma.maintenanceRequest.findFirst({
      where: { id: params.maintenanceRequestId, organisationId },
      include: {
        property: { select: { id: true, publicReference: true, name: true, code: true } },
        space: { select: { id: true, publicReference: true, name: true, code: true } },
        reportedBy: { select: { id: true, firstName: true, lastName: true } },
        attachments: { select: { id: true } },
      },
    });
    if (!request) throw new NotFoundError('Maintenance request not found');

    const [workOrder, quoteRound, similarCount] = await Promise.all([
      prisma.workOrder.findFirst({
        where: { organisationId, maintenanceRequestId: request.id, status: { not: 'CANCELLED' } },
        include: { contractor: { select: { id: true, name: true, companyName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.quoteRound.findFirst({
        where: { organisationId, maintenanceRequestId: request.id, status: { not: 'CANCELLED' } },
        select: {
          id: true,
          publicReference: true,
          title: true,
          status: true,
          dueAt: true,
          awardedAt: true,
          _count: { select: { invitations: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.maintenanceRequest.count({
        where: {
          organisationId,
          propertyId: request.propertyId,
          category: request.category,
          id: { not: request.id },
          reportedAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const resources: AiResource[] = [
      {
        type: 'MAINTENANCE_REQUEST',
        id: request.id,
        publicReference: request.publicReference,
        reference: `Maintenance Request — ${request.title}`,
        label: request.title,
      },
      {
        type: 'PROPERTY',
        id: request.property.id,
        publicReference: request.property.publicReference,
        reference: request.property.name,
        label: request.property.name,
      },
    ];
    if (workOrder) {
      resources.push({
        type: 'WORK_ORDER',
        id: workOrder.id,
        publicReference: workOrder.publicReference,
        reference: `Work Order — ${workOrder.title}`,
        label: workOrder.title,
      });
    }
    if (quoteRound) {
      resources.push({
        type: 'QUOTE_ROUND',
        id: quoteRound.id,
        publicReference: quoteRound.publicReference,
        reference: `Quote Round — ${quoteRound.title}`,
        label: quoteRound.title,
      });
    }

    return {
      resources,
      data: {
        id: request.id,
        title: request.title,
        description: request.description,
        category: request.category,
        priority: request.priority,
        status: request.status,
        procurementPath: request.procurementPath,
        property: request.property,
        space: request.space,
        reportedBy: request.reportedBy
          ? { name: `${request.reportedBy.firstName} ${request.reportedBy.lastName}` }
          : null,
        reportedAt: request.reportedAt,
        resolvedAt: request.resolvedAt,
        closedAt: request.closedAt,
        ageHoursSinceReported: ageInHours(request.reportedAt),
        attachmentCount: request.attachments.length,
        linkedWorkOrder: workOrder
          ? {
              id: workOrder.id,
              status: workOrder.status,
              scheduledAt: workOrder.scheduledAt,
              startedAt: workOrder.startedAt,
              completedAt: workOrder.completedAt,
              contractor: workOrder.contractor
                ? {
                    id: workOrder.contractor.id,
                    name: workOrder.contractor.companyName ?? workOrder.contractor.name,
                  }
                : null,
              estimatedCost: workOrder.estimatedCost ? workOrder.estimatedCost.toString() : null,
              actualCost: workOrder.actualCost ? workOrder.actualCost.toString() : null,
              currencyCode: workOrder.currencyCode,
            }
          : null,
        linkedQuoteRound: quoteRound
          ? {
              id: quoteRound.id,
              status: quoteRound.status,
              dueAt: quoteRound.dueAt,
              awardedAt: quoteRound.awardedAt,
              invitationCount: quoteRound._count.invitations,
            }
          : null,
        similarRequestsSamePropertyCategoryLast12Months: similarCount,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 2. get_maintenance_timeline
// ---------------------------------------------------------------------------

const timelineParams = z.object({ maintenanceRequestId: z.string().min(1) });

const getMaintenanceTimeline: AiToolDefinition<z.infer<typeof timelineParams>, unknown> = {
  name: 'get_maintenance_timeline',
  description:
    'The condensed activity timeline for a maintenance request and everything linked to it (its work order, quote round, contractor quotes, variations) — status changes, contractor assignment, quote submissions, approvals — in chronological order. Use this to explain what actually happened and when, not just the current status.',
  parameters: timelineParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { maintenanceRequestId: { type: 'string' } },
    required: ['maintenanceRequestId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'maintenance.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveMaintenanceRequestProperty(prisma, organisationId, params.maintenanceRequestId),
  handler: async (prisma, organisationId, _auth, params) => {
    const request = await prisma.maintenanceRequest.findFirst({
      where: { id: params.maintenanceRequestId, organisationId },
      select: { id: true, publicReference: true, title: true },
    });
    if (!request) throw new NotFoundError('Maintenance request not found');

    const [workOrders, quoteRounds] = await Promise.all([
      prisma.workOrder.findMany({
        where: { organisationId, maintenanceRequestId: request.id },
        select: { id: true },
      }),
      prisma.quoteRound.findMany({
        where: { organisationId, maintenanceRequestId: request.id },
        select: { id: true },
      }),
    ]);
    const quoteRoundIds = quoteRounds.map((q) => q.id);
    const quotes = quoteRoundIds.length
      ? await prisma.contractorQuote.findMany({
          where: { organisationId, quoteRoundId: { in: quoteRoundIds } },
          select: { id: true },
        })
      : [];
    const variations = workOrders.length
      ? await prisma.workOrderVariation.findMany({
          where: { organisationId, workOrderId: { in: workOrders.map((w) => w.id) } },
          select: { id: true },
        })
      : [];

    const entityIds = [
      request.id,
      ...workOrders.map((w) => w.id),
      ...quoteRoundIds,
      ...quotes.map((q) => q.id),
      ...variations.map((v) => v.id),
    ];

    const events = await prisma.activityEvent.findMany({
      where: { organisationId, entityId: { in: entityIds } },
      include: { actorUser: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      resources: [
        {
          type: 'MAINTENANCE_REQUEST',
          id: request.id,
          publicReference: request.publicReference,
          reference: `Maintenance Request — ${request.title}`,
          label: request.title,
        },
      ] as AiResource[],
      data: {
        eventCount: events.length,
        events: events.map((e) => ({
          timestamp: e.createdAt,
          eventType: e.eventType,
          title: e.title,
          description: e.description,
          actor: e.actorUser ? `${e.actorUser.firstName} ${e.actorUser.lastName}` : 'System',
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 3. get_quote_comparison_facts
// ---------------------------------------------------------------------------

const quoteComparisonParams = z.object({ maintenanceRequestId: z.string().min(1) });

const getQuoteComparisonFacts: AiToolDefinition<z.infer<typeof quoteComparisonParams>, unknown> = {
  name: 'get_quote_comparison_facts',
  description:
    "Structured facts about every contractor quote submitted for a maintenance request's quote round — amount, currency, proposed start, estimated duration, inclusions/exclusions, warranty text, submission status, and each contractor's real compliance eligibility for this trade. Returned in invitation order, never sorted or ranked by price. Attachment CONTENT (PDFs/photos) is never analysed — only structured fields and the text above. Use this to explain differences between quotes; never choose, score, or recommend a winner.",
  parameters: quoteComparisonParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { maintenanceRequestId: { type: 'string' } },
    required: ['maintenanceRequestId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'quotes.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveMaintenanceRequestProperty(prisma, organisationId, params.maintenanceRequestId),
  handler: async (prisma, organisationId, _auth, params) => {
    const service = new QuoteRoundsService(prisma);
    const round = await service.findByMaintenanceRequestId(
      organisationId,
      params.maintenanceRequestId,
    );
    if (!round) {
      return {
        resources: [] as AiResource[],
        data: { hasQuoteRound: false, quotes: [] },
      };
    }

    const resources: AiResource[] = [
      {
        type: 'QUOTE_ROUND',
        id: round.id,
        publicReference: round.publicReference,
        reference: `Quote Round — ${round.title}`,
        label: round.title,
      },
    ];

    const quotes = round.invitations.map((inv) => {
      resources.push({
        type: 'CONTRACTOR_QUOTE',
        id: inv.quote.id,
        publicReference: null,
        reference: `Quote from ${inv.contractor.companyName ?? inv.contractor.name}`,
        label: inv.contractor.companyName ?? inv.contractor.name,
      });
      resources.push({
        type: 'CONTRACTOR',
        id: inv.contractor.id,
        publicReference: null,
        reference: inv.contractor.companyName ?? inv.contractor.name,
        label: inv.contractor.companyName ?? inv.contractor.name,
      });
      return {
        contractorId: inv.contractor.id,
        contractorName: inv.contractor.companyName ?? inv.contractor.name,
        quoteId: inv.quote.id,
        status: inv.quote.status,
        source: inv.quote.source,
        amount: inv.quote.amount ? inv.quote.amount.toString() : null,
        currencyCode: inv.quote.currencyCode,
        proposedStartAt: inv.quote.proposedStartAt,
        estimatedDuration: inv.quote.estimatedDuration,
        inclusions: inv.quote.inclusions,
        exclusions: inv.quote.exclusions,
        warrantyInfo: inv.quote.warrantyInfo,
        submittedAt: inv.quote.submittedAt,
        eligible: inv.eligibility.eligible,
        blockingIssueReasons: inv.eligibility.blockingIssues.map((i) => i.reason),
        warningIssueReasons: inv.eligibility.warnings.map((i) => i.reason),
      };
    });

    return {
      resources,
      data: {
        hasQuoteRound: true,
        roundStatus: round.status,
        scopeDescription: round.scopeDescription,
        currencyCode: round.currencyCode,
        dueAt: round.dueAt,
        quotes,
        attachmentCount: round.attachments.length,
        analysisNote:
          'Attachment content (uploaded PDFs/photos) was not analysed — this comparison uses only the structured quote fields and text fields listed above.',
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 4. get_contractor_eligibility_context
// ---------------------------------------------------------------------------

const contractorEligibilityParams = z.object({
  contractorId: z.string().min(1),
  category: z.string().optional(),
});

const getContractorEligibilityContext: AiToolDefinition<
  z.infer<typeof contractorEligibilityParams>,
  unknown
> = {
  name: 'get_contractor_eligibility_context',
  description:
    "A contractor's real compliance/eligibility standing — either for a specific trade category (blocking issues, warnings, satisfied requirements) or their overall compliance overview across every trade they are classified under. Never invents a rating or ranking — only real credential/requirement state.",
  parameters: contractorEligibilityParams,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      contractorId: { type: 'string' },
      category: {
        type: 'string',
        description: 'A MaintenanceCategory enum value, if narrowing to one trade',
      },
    },
    required: ['contractorId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'contractors.view',
  handler: async (prisma, organisationId, _auth, params) => {
    const contractor = await prisma.contractor.findFirst({
      where: { id: params.contractorId, organisationId },
      select: { id: true, name: true, companyName: true, tradeCategories: true },
    });
    if (!contractor) throw new NotFoundError('Contractor not found');

    const eligibilityService = new ContractorEligibilityService(prisma);
    const resources: AiResource[] = [
      {
        type: 'CONTRACTOR',
        id: contractor.id,
        publicReference: null,
        reference: contractor.companyName ?? contractor.name,
        label: contractor.companyName ?? contractor.name,
      },
    ];

    if (params.category) {
      const result = await eligibilityService.evaluate(
        organisationId,
        contractor.id,
        params.category as MaintenanceCategory,
      );
      return {
        resources,
        data: {
          contractorName: contractor.companyName ?? contractor.name,
          category: params.category,
          eligible: result.eligible,
          blockingIssues: result.blockingIssues.map((i) => ({
            reason: i.reason,
            message: i.message,
          })),
          warnings: result.warnings.map((i) => ({ reason: i.reason, message: i.message })),
          satisfiedRequirementCount: result.satisfiedRequirements.length,
        },
      };
    }

    const overview = await eligibilityService.getComplianceOverview(organisationId, contractor.id);
    return {
      resources,
      data: {
        contractorName: contractor.companyName ?? contractor.name,
        tradeCategories: contractor.tradeCategories,
        overview,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 5. get_approval_context
// ---------------------------------------------------------------------------

const approvalContextParams = z.object({ contractorQuoteId: z.string().min(1) });

const getApprovalContext: AiToolDefinition<z.infer<typeof approvalContextParams>, unknown> = {
  name: 'get_approval_context',
  description:
    "A contractor quote's approval/WaslSign workflow state — what workflow was required at the moment it was selected/awarded (and why, per the organisation's Approval & Acceptance policy), and its current approval/signature status. Explains existing deterministic policy and state — never itself decides or predicts an outcome.",
  parameters: approvalContextParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { contractorQuoteId: { type: 'string' } },
    required: ['contractorQuoteId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'quotes.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveQuoteProperty(prisma, organisationId, params.contractorQuoteId),
  handler: async (prisma, organisationId, _auth, params) => {
    const quote = await prisma.contractorQuote.findFirst({
      where: { id: params.contractorQuoteId, organisationId },
      include: { contractor: { select: { id: true, name: true, companyName: true } } },
    });
    if (!quote) throw new NotFoundError('Contractor quote not found');

    let currentPolicyExplanation: unknown = null;
    if (!quote.requiredWorkflowMode && quote.amount) {
      const approvalPolicyService = new ApprovalPolicyService(prisma);
      currentPolicyExplanation = await approvalPolicyService.resolve(
        organisationId,
        quote.amount.toString(),
        quote.currencyCode,
      );
    }

    return {
      resources: [
        {
          type: 'CONTRACTOR_QUOTE',
          id: quote.id,
          publicReference: null,
          reference: `Quote from ${quote.contractor.companyName ?? quote.contractor.name}`,
          label: quote.contractor.companyName ?? quote.contractor.name,
        },
      ] as AiResource[],
      data: {
        amount: quote.amount ? quote.amount.toString() : null,
        currencyCode: quote.currencyCode,
        selectedAt: quote.selectedAt,
        historicalRequiredWorkflowMode: quote.requiredWorkflowMode,
        historicalPolicySnapshot: quote.approvalPolicySnapshot,
        currentWorkflowMode: quote.workflowMode,
        approvalStatus: quote.approvalStatus,
        signatureStatus: quote.signatureStatus,
        signedAt: quote.signedAt,
        currentPolicyExplanation,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 6. get_variation_context
// ---------------------------------------------------------------------------

const variationContextParams = z.object({ workOrderId: z.string().min(1) });

const getVariationContext: AiToolDefinition<z.infer<typeof variationContextParams>, unknown> = {
  name: 'get_variation_context',
  description:
    "A work order's variations (additional scope/cost discovered after authorisation) and the resulting commercial summary (original amount, approved variations total, authorised total) — deterministic arithmetic already computed by the platform, never recomputed or guessed here.",
  parameters: variationContextParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { workOrderId: { type: 'string' } },
    required: ['workOrderId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'work_orders.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveWorkOrderProperty(prisma, organisationId, params.workOrderId),
  handler: async (prisma, organisationId, _auth, params) => {
    const service = new WorkOrderVariationsService(prisma);
    const [workOrder, variations, summary] = await Promise.all([
      prisma.workOrder.findFirst({
        where: { id: params.workOrderId, organisationId },
        select: { publicReference: true, title: true },
      }),
      service.list(organisationId, params.workOrderId),
      service.getCommercialSummary(organisationId, params.workOrderId),
    ]);
    if (!workOrder) throw new NotFoundError('Work order not found');

    return {
      resources: [
        {
          type: 'WORK_ORDER',
          id: params.workOrderId,
          publicReference: workOrder.publicReference,
          reference: `Work Order — ${workOrder.title}`,
          label: workOrder.title,
        },
      ] as AiResource[],
      data: {
        summary,
        variations: variations.map((v) => ({
          id: v.id,
          description: v.description,
          amountDelta: v.amountDelta.toString(),
          currencyCode: v.currencyCode,
          status: v.status,
          workflowMode: v.workflowMode,
          approvalStatus: v.approvalStatus,
          signatureStatus: v.signatureStatus,
          createdAt: v.createdAt,
          approvedAt: v.approvedAt,
          rejectedAt: v.rejectedAt,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 7. get_communication_timeline
// ---------------------------------------------------------------------------

const communicationTimelineParams = z.object({
  propertyId: z.string().min(1),
  sinceDays: z.number().int().positive().max(180).optional(),
});

const getCommunicationTimeline: AiToolDefinition<
  z.infer<typeof communicationTimelineParams>,
  unknown
> = {
  name: 'get_communication_timeline',
  description:
    "Communications (announcements/notices) sent to a property's residents within a recent period — title, channels, send status and timestamp only. This is broadcast communication history, not a per-resident conversation thread, and carries no sentiment or tone analysis of any kind.",
  parameters: communicationTimelineParams,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      propertyId: { type: 'string' },
      sinceDays: { type: 'number', description: 'How many days back to look, default 30, max 180' },
    },
    required: ['propertyId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'communications.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolvePropertyDirect(prisma, organisationId, params.propertyId),
  handler: async (prisma, organisationId, _auth, params) => {
    const sinceDays = params.sinceDays ?? 30;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const recipientRows = await prisma.communicationRecipient.findMany({
      where: {
        propertyId: params.propertyId,
        communication: { organisationId, sentAt: { gte: since } },
      },
      select: {
        communication: {
          select: { id: true, title: true, status: true, channels: true, sentAt: true },
        },
      },
      distinct: ['communicationId'],
      take: 20,
      orderBy: { communication: { sentAt: 'desc' } },
    });

    return {
      resources: [] as AiResource[],
      data: {
        sinceDays,
        communications: recipientRows.map((r) => r.communication),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 8. get_property_operational_summary
// ---------------------------------------------------------------------------

const propertySummaryParams = z.object({ propertyId: z.string().min(1) });

const getPropertyOperationalSummary: AiToolDefinition<
  z.infer<typeof propertySummaryParams>,
  unknown
> = {
  name: 'get_property_operational_summary',
  description:
    "A property's current operational snapshot: open maintenance requests by priority, active work orders, pending quote rounds, recent activity volume, and strata status if applicable. Use this for 'brief me on this property' style requests — organise the answer by section, never a flat dump.",
  parameters: propertySummaryParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { propertyId: { type: 'string' } },
    required: ['propertyId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'property.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolvePropertyDirect(prisma, organisationId, params.propertyId),
  handler: async (prisma, organisationId, _auth, params) => {
    const property = await prisma.property.findFirst({
      where: { id: params.propertyId, organisationId },
      select: { id: true, publicReference: true, name: true, isStrataManaged: true },
    });
    if (!property) throw new NotFoundError('Property not found');

    const [openByPriority, activeWorkOrders, pendingQuoteRounds, recentActivityCount] =
      await Promise.all([
        prisma.maintenanceRequest.groupBy({
          by: ['priority'],
          where: {
            organisationId,
            propertyId: property.id,
            status: { in: ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS'] },
          },
          _count: { _all: true },
        }),
        prisma.workOrder.count({
          where: {
            organisationId,
            propertyId: property.id,
            status: { in: ['READY', 'SCHEDULED', 'IN_PROGRESS'] },
          },
        }),
        prisma.quoteRound.count({
          where: { organisationId, propertyId: property.id, status: 'OPEN' },
        }),
        prisma.activityEvent.count({
          where: {
            organisationId,
            propertyId: property.id,
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

    let strata: unknown = null;
    if (property.isStrataManaged) {
      const strataService = new StrataService(prisma);
      strata = await strataService.getSummary(organisationId, property.id);
    }

    return {
      resources: [
        {
          type: 'PROPERTY',
          id: property.id,
          publicReference: property.publicReference,
          reference: property.name,
          label: property.name,
        },
      ] as AiResource[],
      data: {
        propertyName: property.name,
        openMaintenanceByPriority: Object.fromEntries(
          openByPriority.map((r) => [r.priority, r._count._all]),
        ),
        activeWorkOrders,
        pendingQuoteRounds,
        recentActivityLast7Days: recentActivityCount,
        strata,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 9. get_related_maintenance_history
// ---------------------------------------------------------------------------

const relatedHistoryParams = z.object({
  maintenanceRequestId: z.string().min(1),
  lookbackMonths: z.number().int().positive().max(36).optional(),
});

const getRelatedMaintenanceHistory: AiToolDefinition<
  z.infer<typeof relatedHistoryParams>,
  unknown
> = {
  name: 'get_related_maintenance_history',
  description:
    "Other maintenance requests on the same property and category (same space when the original request has one) within a lookback window — a deterministically filtered candidate list for recurring-issue investigation. Bounded to 10 results. This is raw history for you to explain in context, never a pre-computed 'pattern detected' verdict.",
  parameters: relatedHistoryParams,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      maintenanceRequestId: { type: 'string' },
      lookbackMonths: { type: 'number', description: 'Default 12, max 36' },
    },
    required: ['maintenanceRequestId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'maintenance.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveMaintenanceRequestProperty(prisma, organisationId, params.maintenanceRequestId),
  handler: async (prisma, organisationId, _auth, params) => {
    const request = await prisma.maintenanceRequest.findFirst({
      where: { id: params.maintenanceRequestId, organisationId },
      select: { id: true, propertyId: true, spaceId: true, category: true },
    });
    if (!request) throw new NotFoundError('Maintenance request not found');

    const lookbackMonths = params.lookbackMonths ?? 12;
    const since = new Date(Date.now() - lookbackMonths * 30 * 24 * 60 * 60 * 1000);

    const related = await prisma.maintenanceRequest.findMany({
      where: {
        organisationId,
        propertyId: request.propertyId,
        category: request.category,
        id: { not: request.id },
        reportedAt: { gte: since },
        ...(request.spaceId ? { spaceId: request.spaceId } : {}),
      },
      select: {
        id: true,
        publicReference: true,
        title: true,
        status: true,
        reportedAt: true,
        resolvedAt: true,
        space: { select: { name: true } },
      },
      orderBy: { reportedAt: 'desc' },
      take: 10,
    });

    return {
      resources: related.map((r) => ({
        type: 'MAINTENANCE_REQUEST' as const,
        id: r.id,
        publicReference: r.publicReference,
        reference: `Maintenance Request — ${r.title}`,
        label: r.title,
      })),
      data: {
        lookbackMonths,
        scopedToSameSpace: Boolean(request.spaceId),
        matchCount: related.length,
        requests: related.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          reportedAt: r.reportedAt,
          resolvedAt: r.resolvedAt,
          space: r.space?.name ?? null,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 10. get_strata_context
// ---------------------------------------------------------------------------

const strataContextParams = z.object({ propertyId: z.string().min(1) });

const getStrataContext: AiToolDefinition<z.infer<typeof strataContextParams>, unknown> = {
  name: 'get_strata_context',
  description:
    'The real strata summary for a property (lots, units of entitlement, reconciliation status) if it is strata-managed — never levy/fund/accounting data, which this platform does not manage.',
  parameters: strataContextParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { propertyId: { type: 'string' } },
    required: ['propertyId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'strata.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolvePropertyDirect(prisma, organisationId, params.propertyId),
  handler: async (prisma, organisationId, _auth, params) => {
    const property = await prisma.property.findFirst({
      where: { id: params.propertyId, organisationId },
      select: { id: true, publicReference: true, name: true, isStrataManaged: true },
    });
    if (!property) throw new NotFoundError('Property not found');

    if (!property.isStrataManaged) {
      return {
        resources: [
          {
            type: 'PROPERTY',
            id: property.id,
            publicReference: property.publicReference,
            reference: property.name,
            label: property.name,
          },
        ] as AiResource[],
        data: { isStrataManaged: false },
      };
    }

    const strataService = new StrataService(prisma);
    const summary = await strataService.getSummary(organisationId, property.id);
    return {
      resources: [
        {
          type: 'PROPERTY',
          id: property.id,
          publicReference: property.publicReference,
          reference: property.name,
          label: property.name,
        },
      ] as AiResource[],
      data: { isStrataManaged: true, summary },
    };
  },
};

// ---------------------------------------------------------------------------
// 11. get_portfolio_exception_candidates
// ---------------------------------------------------------------------------

const portfolioExceptionParams = z.object({});

const getPortfolioExceptionCandidates: AiToolDefinition<
  z.infer<typeof portfolioExceptionParams>,
  unknown
> = {
  name: 'get_portfolio_exception_candidates',
  description:
    "A deterministically filtered, bounded list of possible exceptions across every property this user can access: maintenance requests open longer than 7 days, work orders scheduled in the past but not completed, quote rounds past their due date, and variations pending approval for more than 5 days. Each item carries a plain factual reason (e.g. 'open 14 days'). This is a candidate list for you to explain — never claim statistical anomaly detection.",
  parameters: portfolioExceptionParams,
  parametersJsonSchema: { type: 'object', properties: {}, required: [] },
  riskLevel: 'READ',
  requiredCapability: 'maintenance.view',
  handler: async (prisma, organisationId, auth) => {
    const authz = new AuthorizationService(prisma);
    const accessible = await authz.getAccessiblePropertyIds(auth, 'maintenance.view');
    const propertyFilter = accessible === 'ALL' ? {} : { propertyId: { in: accessible } };
    if (accessible !== 'ALL' && accessible.length === 0) {
      return {
        resources: [] as AiResource[],
        data: {
          staleRequests: [],
          overdueWorkOrders: [],
          overdueQuoteRounds: [],
          pendingVariations: [],
        },
      };
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    const [staleRequests, overdueWorkOrders, overdueQuoteRounds, pendingVariations] =
      await Promise.all([
        prisma.maintenanceRequest.findMany({
          where: {
            organisationId,
            ...propertyFilter,
            status: { in: ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS'] },
            reportedAt: { lte: sevenDaysAgo },
          },
          select: {
            id: true,
            publicReference: true,
            title: true,
            priority: true,
            reportedAt: true,
            property: { select: { name: true } },
          },
          orderBy: { reportedAt: 'asc' },
          take: 10,
        }),
        prisma.workOrder.findMany({
          where: {
            organisationId,
            ...propertyFilter,
            status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
            scheduledAt: { lte: now },
          },
          select: {
            id: true,
            publicReference: true,
            title: true,
            scheduledAt: true,
            property: { select: { name: true } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 10,
        }),
        prisma.quoteRound.findMany({
          where: { organisationId, ...propertyFilter, status: 'OPEN', dueAt: { lte: now } },
          select: {
            id: true,
            publicReference: true,
            title: true,
            dueAt: true,
            property: { select: { name: true } },
          },
          orderBy: { dueAt: 'asc' },
          take: 10,
        }),
        prisma.workOrderVariation.findMany({
          where: {
            organisationId,
            status: 'PENDING_APPROVAL',
            createdAt: { lte: fiveDaysAgo },
            ...(accessible === 'ALL' ? {} : { workOrder: { propertyId: { in: accessible } } }),
          },
          select: {
            id: true,
            publicReference: true,
            description: true,
            createdAt: true,
            workOrder: { select: { title: true, property: { select: { name: true } } } },
          },
          orderBy: { createdAt: 'asc' },
          take: 10,
        }),
      ]);

    const resources: AiResource[] = [
      ...staleRequests.map((r) => ({
        type: 'MAINTENANCE_REQUEST' as const,
        id: r.id,
        publicReference: r.publicReference,
        reference: r.title,
        label: r.title,
      })),
      ...overdueWorkOrders.map((w) => ({
        type: 'WORK_ORDER' as const,
        id: w.id,
        publicReference: w.publicReference,
        reference: w.title,
        label: w.title,
      })),
      ...overdueQuoteRounds.map((q) => ({
        type: 'QUOTE_ROUND' as const,
        id: q.id,
        publicReference: q.publicReference,
        reference: q.title,
        label: q.title,
      })),
      ...pendingVariations.map((v) => ({
        type: 'WORK_ORDER_VARIATION' as const,
        id: v.id,
        publicReference: v.publicReference,
        reference: v.description,
        label: v.description,
      })),
    ];

    return {
      resources,
      data: {
        staleRequests: staleRequests.map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          property: r.property.name,
          reason: `Open ${(ageInHours(r.reportedAt) / 24) | 0} days, no resolution yet`,
        })),
        overdueWorkOrders: overdueWorkOrders.map((w) => ({
          id: w.id,
          title: w.title,
          property: w.property.name,
          reason: `Scheduled for ${w.scheduledAt?.toISOString().slice(0, 10)} but not yet completed`,
        })),
        overdueQuoteRounds: overdueQuoteRounds.map((q) => ({
          id: q.id,
          title: q.title,
          property: q.property.name,
          reason: `Due ${q.dueAt?.toISOString().slice(0, 10)} but still open`,
        })),
        pendingVariations: pendingVariations.map((v) => ({
          id: v.id,
          description: v.description,
          workOrder: v.workOrder.title,
          property: v.workOrder.property.name,
          reason: `Pending approval for ${(ageInHours(v.createdAt) / 24) | 0} days`,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 12. get_work_order_context
// ---------------------------------------------------------------------------

const workOrderContextParams = z.object({ workOrderId: z.string().min(1) });

const getWorkOrderContext: AiToolDefinition<z.infer<typeof workOrderContextParams>, unknown> = {
  name: 'get_work_order_context',
  description:
    'The full context for one work order: status, schedule, contractor, its selected quote, and its commercial summary including any variations. Use this for a work-order-scoped "summarise this" investigation.',
  parameters: workOrderContextParams,
  parametersJsonSchema: {
    type: 'object',
    properties: { workOrderId: { type: 'string' } },
    required: ['workOrderId'],
  },
  riskLevel: 'READ',
  requiredCapability: 'work_orders.view',
  resolvePropertyId: (prisma, organisationId, params) =>
    resolveWorkOrderProperty(prisma, organisationId, params.workOrderId),
  handler: async (prisma, organisationId, _auth, params) => {
    const workOrder = await prisma.workOrder.findFirst({
      where: { id: params.workOrderId, organisationId },
      include: {
        property: { select: { id: true, publicReference: true, name: true } },
        space: { select: { name: true } },
        contractor: { select: { id: true, name: true, companyName: true } },
        selectedQuote: { select: { id: true, amount: true, currencyCode: true } },
        maintenanceRequest: { select: { id: true, publicReference: true, title: true } },
      },
    });
    if (!workOrder) throw new NotFoundError('Work order not found');

    const variationsService = new WorkOrderVariationsService(prisma);
    const commercialSummary = await variationsService.getCommercialSummary(
      organisationId,
      workOrder.id,
    );

    const resources: AiResource[] = [
      {
        type: 'WORK_ORDER',
        id: workOrder.id,
        publicReference: workOrder.publicReference,
        reference: `Work Order — ${workOrder.title}`,
        label: workOrder.title,
      },
      {
        type: 'PROPERTY',
        id: workOrder.property.id,
        publicReference: workOrder.property.publicReference,
        reference: workOrder.property.name,
        label: workOrder.property.name,
      },
    ];
    if (workOrder.maintenanceRequest) {
      resources.push({
        type: 'MAINTENANCE_REQUEST',
        id: workOrder.maintenanceRequest.id,
        publicReference: workOrder.maintenanceRequest.publicReference,
        reference: workOrder.maintenanceRequest.title,
        label: workOrder.maintenanceRequest.title,
      });
    }

    return {
      resources,
      data: {
        title: workOrder.title,
        status: workOrder.status,
        priority: workOrder.priority,
        property: workOrder.property.name,
        space: workOrder.space?.name ?? null,
        scheduledAt: workOrder.scheduledAt,
        startedAt: workOrder.startedAt,
        completedAt: workOrder.completedAt,
        contractor: workOrder.contractor
          ? (workOrder.contractor.companyName ?? workOrder.contractor.name)
          : null,
        selectedQuote: workOrder.selectedQuote
          ? {
              amount: workOrder.selectedQuote.amount?.toString() ?? null,
              currencyCode: workOrder.selectedQuote.currencyCode,
            }
          : null,
        commercialSummary,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The complete Wasl AI tool allow-list. Every tool wraps an authorized,
 * already-scoped read of real domain data — there is no generic query
 * tool, and this array is the only place a new capability can ever be
 * exposed to the model. Order is presentation-only (also the order
 * surfaced to the provider). */
export const AI_TOOLS: AiToolDefinition<any, unknown>[] = [
  getMaintenanceRequestContext,
  getMaintenanceTimeline,
  getQuoteComparisonFacts,
  getContractorEligibilityContext,
  getApprovalContext,
  getVariationContext,
  getCommunicationTimeline,
  getPropertyOperationalSummary,
  getRelatedMaintenanceHistory,
  getStrataContext,
  getPortfolioExceptionCandidates,
  getWorkOrderContext,
];

export const AI_TOOLS_BY_NAME: ReadonlyMap<string, AiToolDefinition<any, unknown>> = new Map(
  AI_TOOLS.map((t) => [t.name, t]),
);
