import type { MaintenanceRequestStatus, Prisma, PrismaClient } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError.js';
import type { PaginatedResult } from '../../lib/pagination.js';
import { withPublicReference } from '../../lib/public-reference.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import { notifyOrgStaff, notifyUser } from '../notifications/notifications.js';
import { residentWorkOrderStatusLabel } from '../work-orders/work-orders.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  CreateMaintenanceRequestInput,
  MaintenanceRequestQuery,
  UpdateMaintenanceRequestInput,
} from './maintenance.schemas.js';

const requestInclude = {
  property: { select: { id: true, publicReference: true, name: true, code: true } },
  space: { select: { id: true, publicReference: true, name: true, code: true } },
  reportedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.MaintenanceRequestInclude;

/**
 * Explicit transition table rather than a generic workflow engine — the
 * only statuses that exist are the ones listed here, and every edge is
 * intentional. CANCELLED is reachable from every non-terminal state;
 * RESOLVED only moves forward to CLOSED.
 */
const VALID_TRANSITIONS: Record<MaintenanceRequestStatus, MaintenanceRequestStatus[]> = {
  NEW: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

function formatStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export class MaintenanceService {
  private readonly authz: AuthorizationService;

  constructor(private readonly prisma: PrismaClient) {
    this.authz = new AuthorizationService(prisma);
  }

  private async assertPropertyInOrg(organisationId: string, propertyId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
    });
    if (!property) {
      throw new NotFoundError('Property not found');
    }
    return property;
  }

  private async assertSpaceInProperty(organisationId: string, propertyId: string, spaceId: string) {
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, propertyId, organisationId },
    });
    if (!space) {
      throw new NotFoundError('Space not found on this property');
    }
    return space;
  }

  /**
   * A resident may only report against a space they are actually tied to
   * (their own unit), or — with no space — against the property in
   * general, provided they have any active membership on it at all.
   */
  private async assertResidentCanReport(
    organisationId: string,
    userId: string,
    propertyId: string,
    spaceId: string | undefined,
  ) {
    const contact = await this.prisma.propertyContact.findFirst({
      where: { organisationId, userId },
    });
    if (!contact) {
      throw new ForbiddenError('You are not associated with this property');
    }

    const membership = await this.prisma.propertyMembership.findFirst({
      where: {
        contactId: contact.id,
        propertyId,
        status: 'ACTIVE',
        ...(spaceId ? { spaceId } : {}),
      },
    });
    if (!membership) {
      throw new ForbiddenError('You are not associated with this property or space');
    }
  }

  async create(organisationId: string, auth: AuthContext, input: CreateMaintenanceRequestInput) {
    const property = await this.assertPropertyInOrg(organisationId, input.propertyId);

    if (input.spaceId) {
      await this.assertSpaceInProperty(organisationId, input.propertyId, input.spaceId);
    }

    const isResident = !auth.orgRole;
    if (isResident) {
      await this.assertResidentCanReport(
        organisationId,
        auth.userId,
        input.propertyId,
        input.spaceId,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const request = await withPublicReference('MR', (publicReference) =>
        tx.maintenanceRequest.create({
          data: {
            organisationId,
            publicReference,
            propertyId: input.propertyId,
            spaceId: input.spaceId ?? null,
            reportedByUserId: auth.userId,
            title: input.title,
            description: input.description,
            category: input.category,
            priority: input.priority,
            status: 'NEW',
            reportedAt: new Date(),
          },
          include: requestInclude,
        }),
      );

      await recordActivity(tx, {
        organisationId,
        propertyId: input.propertyId,
        spaceId: input.spaceId ?? null,
        actorUserId: auth.userId,
        eventType: 'MAINTENANCE_REQUEST_CREATED',
        entityType: 'MaintenanceRequest',
        entityId: request.id,
        title: `Maintenance request reported: ${request.title}`,
        description: `${formatStatusLabel(request.category)} · ${formatStatusLabel(request.priority)} priority · ${property.name}`,
      });

      await notifyOrgStaff(
        tx,
        organisationId,
        {
          title: `New request: ${request.title}`,
          body: `${property.name} · ${formatStatusLabel(request.priority)} priority`,
          entityType: 'MaintenanceRequest',
          entityId: request.id,
        },
        { excludeUserId: auth.userId },
      );

      return request;
    });
  }

  async list(
    organisationId: string,
    auth: AuthContext,
    query: MaintenanceRequestQuery,
  ): Promise<
    PaginatedResult<Prisma.MaintenanceRequestGetPayload<{ include: typeof requestInclude }>>
  > {
    const where: Prisma.MaintenanceRequestWhereInput = { organisationId };

    // Three tiers, resolved once here and nowhere else:
    // 1. Org staff (OWNER/ADMIN, or MEMBER which already had this) — every
    //    request in the organisation, unchanged from before this milestone.
    // 2. A property-scoped operational user (e.g. PROPERTY_MANAGER) with
    //    maintenance.view on at least one property — every request on
    //    their assigned properties, never the whole organisation.
    // 3. Everyone else (a plain resident/tenant, or an operational role an
    //    organisation has stripped maintenance.view from) — only the
    //    requests they personally reported. Never optional/overridable by
    //    query params — this is not a filter, it's the ceiling.
    const accessibleProperties = await this.authz.getAccessiblePropertyIds(
      auth,
      'maintenance.view',
    );
    if (accessibleProperties === 'ALL') {
      if (query.propertyId) where.propertyId = query.propertyId;
    } else if (accessibleProperties.length > 0) {
      // query.propertyId, if given, must narrow within the accessible set —
      // never replace it wholesale (that would let a caller-supplied
      // propertyId escape their portfolio).
      if (query.propertyId) {
        if (!accessibleProperties.includes(query.propertyId)) {
          throw new ForbiddenError('You do not have access to this property');
        }
        where.propertyId = query.propertyId;
      } else {
        where.propertyId = { in: accessibleProperties };
      }
    } else {
      where.reportedByUserId = auth.userId;
      if (query.propertyId) where.propertyId = query.propertyId;
    }

    if (query.spaceId) where.spaceId = query.spaceId;
    if (query.status) where.status = { in: query.status };
    if (query.priority) where.priority = query.priority;
    if (query.category) where.category = query.category;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.maintenanceRequest.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: requestInclude,
      }),
      this.prisma.maintenanceRequest.count({ where }),
    ]);

    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getById(organisationId: string, auth: AuthContext, requestId: string) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: requestId, organisationId },
      include: requestInclude,
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    const isOwnReport = request.reportedByUserId === auth.userId;
    const hasOperationalAccess =
      !auth.orgRole && (await this.authz.can(auth, 'maintenance.view', request.propertyId));
    const isOrgStaff =
      auth.orgRole === 'OWNER' || auth.orgRole === 'ADMIN' || auth.orgRole === 'MEMBER';

    if (!isOrgStaff && !isOwnReport && !hasOperationalAccess) {
      // Probing another resident's (or another property's) request id —
      // 404, not 403, so existence isn't leaked.
      throw new NotFoundError('Maintenance request not found');
    }

    // A resident (own report, no operational capability on this property)
    // gets only a plain-language progress label — never the WorkOrder
    // object itself (no cost, contractor, or workflow fields). Org staff
    // and property-scoped operational users both get the full record.
    if (!isOrgStaff && !hasOperationalAccess) {
      const workOrder = await this.prisma.workOrder.findFirst({
        where: { organisationId, maintenanceRequestId: request.id, status: { not: 'CANCELLED' } },
        select: { status: true },
      });
      return {
        ...request,
        residentWorkOrderStatus: workOrder ? residentWorkOrderStatusLabel[workOrder.status] : null,
      };
    }

    return request;
  }

  async updateStatus(
    organisationId: string,
    actorUserId: string,
    requestId: string,
    nextStatus: MaintenanceRequestStatus,
  ) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: requestId, organisationId },
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    const allowed = VALID_TRANSITIONS[request.status];
    if (!allowed.includes(nextStatus)) {
      throw new ConflictError(
        `Cannot move a request from ${formatStatusLabel(request.status)} to ${formatStatusLabel(nextStatus)}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.maintenanceRequest.update({
        where: { id: requestId },
        data: {
          status: nextStatus,
          resolvedAt: nextStatus === 'RESOLVED' ? new Date() : request.resolvedAt,
          closedAt: nextStatus === 'CLOSED' ? new Date() : request.closedAt,
        },
        include: requestInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: request.propertyId,
        spaceId: request.spaceId,
        actorUserId,
        eventType: 'MAINTENANCE_REQUEST_STATUS_CHANGED',
        entityType: 'MaintenanceRequest',
        entityId: request.id,
        title: `Maintenance request moved to ${formatStatusLabel(nextStatus)}`,
        description: request.title,
      });

      if (request.reportedByUserId && request.reportedByUserId !== actorUserId) {
        await notifyUser(tx, {
          organisationId,
          userId: request.reportedByUserId,
          title: `Your request '${request.title}' moved to ${formatStatusLabel(nextStatus)}`,
          entityType: 'MaintenanceRequest',
          entityId: request.id,
        });
      }

      return updated;
    });
  }

  async update(
    organisationId: string,
    actorUserId: string,
    requestId: string,
    input: UpdateMaintenanceRequestInput,
  ) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: requestId, organisationId },
    });
    if (!request) {
      throw new NotFoundError('Maintenance request not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.maintenanceRequest.update({
        where: { id: requestId },
        data: input,
        include: requestInclude,
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: request.propertyId,
        spaceId: request.spaceId,
        actorUserId,
        eventType: 'MAINTENANCE_REQUEST_UPDATED',
        entityType: 'MaintenanceRequest',
        entityId: request.id,
        title: `Maintenance request updated: ${updated.title}`,
        description: `Updated: ${Object.keys(input).join(', ')}`,
      });

      return updated;
    });
  }
}
