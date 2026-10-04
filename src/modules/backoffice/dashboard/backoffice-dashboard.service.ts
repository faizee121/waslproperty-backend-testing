import type { PrismaClient } from '@prisma/client';

const ACTIVE_WORK_ORDER_STATUSES = ['READY', 'SCHEDULED', 'IN_PROGRESS'] as const;
const OPEN_REQUEST_STATUSES = ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS'] as const;

/** Real platform-wide counts only — never a fabricated metric (no revenue,
 * uptime, SLA, or engagement score exists in this application). */
export class BackofficeDashboardService {
  constructor(private readonly prisma: PrismaClient) {}

  async getMetrics() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      organisations,
      organisationsCreatedThisWeek,
      platformUsers,
      properties,
      spaces,
      activeMemberships,
      openMaintenanceRequests,
      activeWorkOrders,
      activeContractors,
      communicationsSentThisWeek,
      scheduledCommunications,
      failedDeliveries,
      pendingInvitations,
    ] = await Promise.all([
      this.prisma.organisation.count(),
      this.prisma.organisation.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.employee.count({ where: { isActive: true } }),
      this.prisma.property.count(),
      this.prisma.space.count(),
      this.prisma.propertyMembership.count({ where: { status: 'ACTIVE' } }),
      this.prisma.maintenanceRequest.count({
        where: { status: { in: [...OPEN_REQUEST_STATUSES] } },
      }),
      this.prisma.workOrder.count({ where: { status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } } }),
      this.prisma.contractor.count({ where: { status: 'ACTIVE' } }),
      this.prisma.communication.count({
        where: { status: 'SENT', sentAt: { gte: sevenDaysAgo } },
      }),
      this.prisma.communication.count({ where: { status: 'SCHEDULED' } }),
      this.prisma.communicationDelivery.count({ where: { status: 'FAILED' } }),
      this.prisma.contactInvite.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      organisations: { total: organisations, createdThisWeek: organisationsCreatedThisWeek },
      platformUsers: { total: platformUsers },
      properties: { total: properties },
      spaces: { total: spaces },
      activeMemberships: { total: activeMemberships },
      openMaintenanceRequests: { total: openMaintenanceRequests },
      activeWorkOrders: { total: activeWorkOrders },
      activeContractors: { total: activeContractors },
      communicationsSentThisWeek: { total: communicationsSentThisWeek },
      scheduledCommunications: { total: scheduledCommunications },
      failedDeliveries: { total: failedDeliveries },
      pendingInvitations: { total: pendingInvitations },
    };
  }

  /** Real, cross-organisation operational history — sourced from the same
   * ActivityEvent rows the customer app already writes (M3-M10), not a
   * separate feed. PlatformAuditEvent (internal Backoffice mutations) is
   * surfaced through its own /backoffice/audit endpoint, since it's a
   * conceptually different, not-customer-visible trail. */
  async getRecentActivity(limit = 10) {
    const events = await this.prisma.activityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        organisation: { select: { id: true, name: true } },
        actorUser: { select: { firstName: true, lastName: true } },
      },
    });

    return events.map((event) => ({
      id: event.id,
      title: event.title,
      eventType: event.eventType,
      organisation: event.organisation,
      actor: event.actorUser ? `${event.actorUser.firstName} ${event.actorUser.lastName}` : null,
      createdAt: event.createdAt,
    }));
  }
}
