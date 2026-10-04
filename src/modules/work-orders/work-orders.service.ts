import type { Prisma, PrismaClient, WorkOrderStatus } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError.js';
import type { PaginatedResult } from '../../lib/pagination.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { ContractorsService } from '../contractors/contractors.service.js';
import { ContractorEligibilityService } from '../contractors/compliance/eligibility.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import { notifyUser } from '../notifications/notifications.js';
import { canReleaseWorkOrder, deriveWorkflowResult } from '../quotes/workflow-result.js';
import type {
  AssignContractorInput,
  CreateWorkOrderInput,
  UpdateCostInput,
  UpdateWorkOrderStatusInput,
  WorkOrderQuery,
} from './work-orders.schemas.js';

const workOrderInclude = {
  property: { select: { id: true, publicReference: true, name: true, code: true } },
  space: { select: { id: true, publicReference: true, name: true, code: true } },
  maintenanceRequest: { select: { id: true, publicReference: true, title: true, category: true } },
  contractor: { select: { id: true, name: true, companyName: true, status: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  quotes: {
    orderBy: { createdAt: 'desc' },
    include: { contractor: { select: { id: true, name: true, companyName: true, email: true } } },
  },
  // Set only for a Work Order authorised via the M11 RFQ award flow — see
  // WorkOrder.selectedQuoteId's own doc comment. Null for legacy/Direct
  // Work, where the frontend falls back to `quotes[0]` exactly as before.
  selectedQuote: {
    include: { contractor: { select: { id: true, name: true, companyName: true, email: true } } },
  },
  quoteRound: { select: { id: true, publicReference: true, title: true, dueAt: true } },
} satisfies Prisma.WorkOrderInclude;

/** Same shape as MaintenanceService's transition table — see that file's comment. */
const VALID_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * The only work-order information a resident is ever allowed to see —
 * plain operational progress, never a status name, cost, or contractor.
 * CANCELLED deliberately maps to null: a resident sees the underlying
 * maintenance request's own status in that case, not an internal decision.
 */
export const residentWorkOrderStatusLabel: Record<WorkOrderStatus, string | null> = {
  DRAFT: 'Being reviewed',
  READY: 'Work being arranged',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: null,
};

function formatStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export class WorkOrdersService {
  private readonly contractorsService: ContractorsService;
  private readonly authz: AuthorizationService;
  private readonly eligibility: ContractorEligibilityService;

  constructor(private readonly prisma: PrismaClient) {
    this.contractorsService = new ContractorsService(prisma);
    this.authz = new AuthorizationService(prisma);
    this.eligibility = new ContractorEligibilityService(prisma);
  }

  private async getOwned(organisationId: string, workOrderId: string) {
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, organisationId },
      include: workOrderInclude,
    });
    if (!workOrder) {
      throw new NotFoundError('Work order not found');
    }
    return workOrder;
  }

  /**
   * The quote that currently governs whether this work order may leave
   * DRAFT — the most recent quote that hasn't been rejected/expired. A work
   * order with no such quote (or one still on NONE) has nothing to wait for.
   */
  private governingQuote(
    workOrder: Prisma.WorkOrderGetPayload<{ include: typeof workOrderInclude }>,
  ) {
    return workOrder.quotes.find((q) => q.status !== 'REJECTED' && q.status !== 'EXPIRED') ?? null;
  }

  async create(organisationId: string, actorUserId: string, input: CreateWorkOrderInput) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: input.maintenanceRequestId, organisationId },
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    // Copied at creation, never re-derived later — see WorkOrder.currencyCode
    // doc comment in schema.prisma.
    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { currencyCode: true },
    });

    const existing = await this.prisma.workOrder.findFirst({
      where: { maintenanceRequestId: input.maintenanceRequestId, status: { not: 'CANCELLED' } },
    });
    if (existing) {
      throw new ConflictError('This maintenance request already has a work order');
    }
    // Direct Work and an active RFQ round are mutually exclusive for the
    // same request — a manager who's already out for competitive quotes
    // shouldn't be able to also bypass that with a direct work order.
    const activeRound = await this.prisma.quoteRound.findFirst({
      where: {
        maintenanceRequestId: input.maintenanceRequestId,
        status: { in: ['DRAFT', 'OPEN'] },
      },
    });
    if (activeRound) {
      throw new ConflictError('This maintenance request has an active quote round');
    }

    return this.prisma.$transaction(async (tx) => {
      const workOrder = await withPublicReference('WO', (publicReference) =>
        tx.workOrder.create({
          data: {
            organisationId,
            publicReference,
            propertyId: request.propertyId,
            spaceId: request.spaceId,
            maintenanceRequestId: request.id,
            title: input.title,
            description: input.description,
            priority: input.priority,
            status: 'DRAFT',
            createdByUserId: actorUserId,
            currencyCode: organisation.currencyCode,
          },
          include: workOrderInclude,
        }),
      );

      await tx.maintenanceRequest.update({
        where: { id: request.id },
        data: { procurementPath: request.procurementPath ?? 'DIRECT_WORK' },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: request.propertyId,
        spaceId: request.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_CREATED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Work order created: ${workOrder.title}`,
        description: `${formatStatusLabel(input.priority)} priority`,
      });

      if (request.reportedByUserId) {
        await notifyUser(tx, {
          organisationId,
          userId: request.reportedByUserId,
          title: `Work has started on your request '${request.title}'`,
          entityType: 'MaintenanceRequest',
          entityId: request.id,
        });
      }

      return workOrder;
    });
  }

  async list(
    organisationId: string,
    auth: AuthContext,
    query: WorkOrderQuery,
  ): Promise<PaginatedResult<Prisma.WorkOrderGetPayload<{ include: typeof workOrderInclude }>>> {
    const accessible = await this.authz.getAccessiblePropertyIds(auth, 'work_orders.view');
    if (accessible !== 'ALL' && accessible.length === 0) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    }
    if (query.propertyId && accessible !== 'ALL' && !accessible.includes(query.propertyId)) {
      throw new ForbiddenError('You do not have access to this property');
    }

    const where: Prisma.WorkOrderWhereInput = {
      organisationId,
      ...(accessible !== 'ALL' && !query.propertyId ? { propertyId: { in: accessible } } : {}),
    };
    if (query.propertyId) where.propertyId = query.propertyId;
    if (query.status) where.status = { in: query.status };
    if (query.priority) where.priority = query.priority;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: workOrderInclude,
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getById(organisationId: string, workOrderId: string) {
    return this.getOwned(organisationId, workOrderId);
  }

  async findByMaintenanceRequestId(organisationId: string, maintenanceRequestId: string) {
    return this.prisma.workOrder.findFirst({
      where: { organisationId, maintenanceRequestId, status: { not: 'CANCELLED' } },
      include: workOrderInclude,
    });
  }

  async updateStatus(
    organisationId: string,
    // Null for a system-triggered transition (e.g. auto-release once a
    // quote's workflow completes) — there is no human actor for that event.
    actorUserId: string | null,
    workOrderId: string,
    input: UpdateWorkOrderStatusInput,
  ) {
    const workOrder = await this.getOwned(organisationId, workOrderId);

    const allowed = VALID_TRANSITIONS[workOrder.status];
    if (!allowed.includes(input.status)) {
      throw new ConflictError(
        `Cannot move a work order from ${formatStatusLabel(workOrder.status)} to ${formatStatusLabel(input.status)}`,
      );
    }

    if (input.status === 'READY') {
      const governingQuote = this.governingQuote(workOrder);
      // A governing quote with no workflowMode yet means a decision is
      // still outstanding, never "nothing to wait for" — that's distinct
      // from there being no governing quote at all (deriveWorkflowResult's
      // NOT_REQUIRED case, which stays a legitimate way to release a work
      // order that never needed a quote). Without this check, an
      // unconfigured or currency-mismatched Approval & Acceptance policy
      // would silently be indistinguishable from "no approval required" —
      // exactly the accidental bypass the M12 Approval Policy milestone
      // exists to prevent.
      if (governingQuote && !governingQuote.workflowMode) {
        throw new ConflictError(
          'Cannot release this work order: choose an Approval & Acceptance workflow for its quote first',
        );
      }
      const result = deriveWorkflowResult(
        governingQuote?.workflowMode ?? null,
        governingQuote?.approvalStatus ?? null,
        governingQuote?.signatureStatus ?? null,
      );
      if (!canReleaseWorkOrder(result)) {
        throw new ConflictError(
          `Cannot release this work order: its quote's workflow is ${result.toLowerCase().replace('_', ' ')}`,
        );
      }
    }

    if (input.status === 'SCHEDULED' && !input.scheduledAt) {
      throw new ConflictError('A scheduled date is required to move a work order to Scheduled');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: input.status,
          scheduledAt: input.status === 'SCHEDULED' ? input.scheduledAt : workOrder.scheduledAt,
          startedAt: input.status === 'IN_PROGRESS' ? new Date() : workOrder.startedAt,
          completedAt: input.status === 'COMPLETED' ? new Date() : workOrder.completedAt,
        },
        include: workOrderInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'WORK_ORDER_STATUS_CHANGED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `Work order moved to ${formatStatusLabel(input.status)}`,
        description: actorUserId
          ? workOrder.title
          : `${workOrder.title} · released automatically once its workflow completed`,
      });

      if (workOrder.maintenanceRequestId) {
        const request = await tx.maintenanceRequest.findUnique({
          where: { id: workOrder.maintenanceRequestId },
          select: { id: true, title: true, reportedByUserId: true },
        });
        const residentLabel = residentWorkOrderStatusLabel[input.status];
        if (request?.reportedByUserId && residentLabel) {
          await notifyUser(tx, {
            organisationId,
            userId: request.reportedByUserId,
            title: `Your request '${request.title}': ${residentLabel.toLowerCase()}`,
            entityType: 'MaintenanceRequest',
            entityId: request.id,
          });
        }
      }

      return updated;
    });
  }

  async assignContractor(
    organisationId: string,
    actorUserId: string,
    workOrderId: string,
    input: AssignContractorInput,
  ) {
    const workOrder = await this.getOwned(organisationId, workOrderId);
    const contractor = await this.contractorsService.assertActiveInOrg(
      organisationId,
      input.contractorId,
    );

    // Backend-authoritative: a manually crafted request against this
    // endpoint can never bypass compliance the way frontend-only filtering
    // could. Evaluated against the work order's own category (resolved via
    // its originating MaintenanceRequest — see
    // ContractorEligibilityService's own doc comment) so the same
    // contractor can be blocked for Electrical work and freely assigned to
    // Plumbing work. An organisation with no configured requirements for
    // this trade sees identical behaviour to before this milestone — the
    // eligibility check only ever adds a real, configured blocker, never a
    // default one.
    const eligibility = await this.eligibility.evaluateForWorkOrder(
      organisationId,
      contractor.id,
      workOrderId,
    );
    if (!eligibility.eligible) {
      throw new ForbiddenError(
        `${contractor.name} is not eligible for this work order`,
        eligibility,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id: workOrderId },
        data: { contractorId: contractor.id },
        include: workOrderInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: workOrder.propertyId,
        spaceId: workOrder.spaceId,
        actorUserId,
        eventType: 'CONTRACTOR_ASSIGNED',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        title: `${contractor.name} assigned`,
        description: workOrder.title,
      });

      return updated;
    });
  }

  async updateCost(organisationId: string, workOrderId: string, input: UpdateCostInput) {
    await this.getOwned(organisationId, workOrderId);
    return this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: input,
      include: workOrderInclude,
    });
  }

  /**
   * Powers the contractor-selector UX: eligibility for every ACTIVE
   * contractor in the organisation against this one work order's trade, so
   * the frontend can group/prioritise eligible contractors rather than
   * showing every contractor equally. This is a UX convenience only — the
   * real gate is assignContractor's own evaluateForWorkOrder call, which a
   * caller of this endpoint could never bypass by, say, hiding an
   * ineligible contractor from the list and assigning them directly.
   */
  async listContractorEligibility(organisationId: string, workOrderId: string) {
    const workOrder = await this.getOwned(organisationId, workOrderId);
    const category = workOrder.maintenanceRequest?.category ?? null;

    const contractors = await this.prisma.contractor.findMany({
      where: { organisationId, status: 'ACTIVE' },
      select: { id: true, name: true, companyName: true },
      orderBy: { name: 'asc' },
    });

    const results = await Promise.all(
      contractors.map(async (contractor) => ({
        contractor: {
          id: contractor.id,
          name: contractor.name,
          companyName: contractor.companyName,
        },
        eligibility: await this.eligibility.evaluate(organisationId, contractor.id, category),
      })),
    );

    return { category, contractors: results };
  }
}
