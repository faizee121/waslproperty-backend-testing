import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../../errors/AppError.js';
import type { PaginatedResult } from '../../../lib/pagination.js';
import { recordPlatformActivity } from '../../../platform/audit.js';
import type {
  BackofficeOrganisationsQuery,
  UpdateOrganisationInput,
} from './backoffice-organisations.schemas.js';

const STAFF_PREVIEW_LIMIT = 5;
const PROPERTIES_PREVIEW_LIMIT = 5;
const ACTIVITY_PREVIEW_LIMIT = 5;
const OPEN_REQUEST_STATUSES = ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS'] as const;
const ACTIVE_WORK_ORDER_STATUSES = ['READY', 'SCHEDULED', 'IN_PROGRESS'] as const;

export class BackofficeOrganisationsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: BackofficeOrganisationsQuery): Promise<PaginatedResult<unknown>> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.organisation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          _count: { select: { memberships: true, properties: true } },
        },
      }),
      this.prisma.organisation.count({ where }),
    ]);

    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getById(id: string) {
    const organisation = await this.prisma.organisation.findUnique({ where: { id } });
    if (!organisation) throw new NotFoundError('Organisation not found');

    const [
      propertyCount,
      spaceCount,
      activeMemberships,
      openRequests,
      activeWorkOrders,
      staffUsers,
      properties,
      recentActivity,
    ] = await Promise.all([
      this.prisma.property.count({ where: { organisationId: id } }),
      this.prisma.space.count({ where: { property: { organisationId: id } } }),
      this.prisma.propertyMembership.count({ where: { organisationId: id, status: 'ACTIVE' } }),
      this.prisma.maintenanceRequest.count({
        where: { organisationId: id, status: { in: [...OPEN_REQUEST_STATUSES] } },
      }),
      this.prisma.workOrder.count({
        where: { organisationId: id, status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } },
      }),
      this.prisma.organisationMembership.findMany({
        where: { organisationId: id },
        take: STAFF_PREVIEW_LIMIT,
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      }),
      this.prisma.property.findMany({
        where: { organisationId: id },
        take: PROPERTIES_PREVIEW_LIMIT,
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { spaces: true } } },
      }),
      this.prisma.activityEvent.findMany({
        where: { organisationId: id },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_PREVIEW_LIMIT,
        include: { actorUser: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    return {
      organisation,
      summary: {
        properties: propertyCount,
        spaces: spaceCount,
        activeMemberships,
        openRequests,
        activeWorkOrders,
      },
      staffUsers: staffUsers.map((m) => ({
        userId: m.userId,
        name: `${m.user.firstName} ${m.user.lastName}`,
        email: m.user.email,
        role: m.role,
        status: m.status,
        joinedAt: m.createdAt,
      })),
      properties: properties.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        spaceCount: p._count.spaces,
      })),
      recentActivity: recentActivity.map((e) => ({
        id: e.id,
        title: e.title,
        eventType: e.eventType,
        actor: e.actorUser ? `${e.actorUser.firstName} ${e.actorUser.lastName}` : null,
        createdAt: e.createdAt,
      })),
    };
  }

  async update(
    id: string,
    input: UpdateOrganisationInput,
    actor: { employeeId: string; platformRole: import('@prisma/client').PlatformRole },
  ) {
    const existing = await this.prisma.organisation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Organisation not found');

    const { reason, ...changes } = input;
    if (Object.keys(changes).length === 0) return existing;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.organisation.update({ where: { id }, data: changes });

      await recordPlatformActivity(tx, {
        actorEmployeeId: actor.employeeId,
        platformRole: actor.platformRole,
        action: 'organisation.updated',
        entityType: 'Organisation',
        entityId: id,
        organisationId: id,
        reason,
        before: { name: existing.name, status: existing.status },
        after: { name: updated.name, status: updated.status },
      });

      return updated;
    });
  }
}
