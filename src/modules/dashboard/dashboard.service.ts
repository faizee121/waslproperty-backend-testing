import {
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceRequestStatus,
  ContractorQuoteStatus,
  type Prisma,
  type PrismaClient,
  WorkOrderStatus,
} from '@prisma/client';
import { ActivityService } from '../activity/activity.service.js';
import { getOccupiedSpaceIds } from '../../lib/occupancy.js';
import {
  getAttentionItems,
  OPEN_REQUEST_STATUSES,
  type AttentionItem,
  type AttentionItemType,
  type AttentionSeverity,
} from '../../lib/attention-engine.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import {
  AuthorizationService,
  type AccessibleProperties,
} from '../authorization/authorization.service.js';
import { deriveWorkflowResult, type WorkflowResult } from '../quotes/workflow-result.js';
import type { DashboardPeriod, DashboardQuery } from './dashboard.schemas.js';

// Re-exported for backward compatibility — these types now live in the
// shared attention-engine module (src/lib/attention-engine.ts), reused by
// both this org-wide dashboard and the property-scoped attention list.
export type { AttentionItem, AttentionItemType, AttentionSeverity };

/**
 * Precise semantics — these are deliberate choices, not incidental:
 *
 * - openRequests / activeWorkOrders / pendingSignature / portfolio /
 *   categoryBreakdown / priorityBreakdown / attention are all POINT-IN-TIME
 *   snapshots. An open request doesn't stop being open because it falls
 *   outside a 7-day window, so `period` never affects these.
 * - `period` affects exactly three things: completedThisPeriod, trend, and
 *   averageResolutionHours.
 * - OPEN REQUEST = MaintenanceRequest.status IN (NEW, UNDER_REVIEW, IN_PROGRESS).
 * - ACTIVE WORK ORDER = WorkOrder.status IN (READY, SCHEDULED, IN_PROGRESS).
 * - COMPLETED THIS PERIOD = WorkOrder.status = COMPLETED with completedAt
 *   inside [periodStart, periodEnd]. Deliberately work-orders-only, not a
 *   blended requests+work-orders figure — that would be a synthetic number.
 *   Request completions remain visible via requestsSnapshot + average
 *   resolution.
 * - PENDING SIGNATURE = ContractorQuote.workflowMode IN (SIGNATURE_ONLY,
 *   APPROVAL_THEN_SIGNATURE) AND signatureStatus IN (PENDING, PARTIALLY_SIGNED).
 * - AVERAGE RESOLUTION = mean(resolvedAt - reportedAt) in hours, over
 *   requests resolved within the period. Null when nothing resolved in the
 *   period (never 0 — 0 would falsely read as "instant").
 * - categoryBreakdown / priorityBreakdown are scoped to currently-open
 *   requests (not period-bound, not all-time) — the operationally useful cut.
 * - quotesSnapshot.byWorkflowResult reuses the existing pure
 *   deriveWorkflowResult() rather than reimplementing its logic.
 * - Every query below filters by organisationId directly — every relevant
 *   model already carries it denormalized, so no joins are needed for
 *   scoping — PLUS, since the property-role-authorization milestone, by
 *   `propertyIds` (AccessibleProperties — 'ALL' for org staff, an explicit
 *   list for a property-scoped manager). This is the single most
 *   safety-critical property of this file: a property-scoped manager's
 *   dashboard is a real, correctly-filtered aggregate over exactly their
 *   assigned properties, never a peek at the whole organisation.
 */

const ACTIVE_WORK_ORDER_STATUSES: WorkOrderStatus[] = ['READY', 'SCHEDULED', 'IN_PROGRESS'];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface DashboardResponse {
  period: DashboardPeriod;
  periodStart: string;
  periodEnd: string;
  organisation: { id: string; name: string };
  attention: { items: AttentionItem[]; totalCount: number; displayLimit: number };
  metrics: {
    openRequests: number;
    activeWorkOrders: number;
    completedThisPeriod: number;
    pendingSignature: number;
  };
  portfolio: {
    totalProperties: number;
    totalSpaces: number;
    occupiedSpaces: number;
    vacantSpaces: number;
    occupancyRatePct: number;
  };
  requestsSnapshot: { byStatus: Array<{ status: MaintenanceRequestStatus; count: number }> };
  workOrdersSnapshot: { byStatus: Array<{ status: WorkOrderStatus; count: number }> };
  quotesSnapshot: {
    byStatus: Array<{ status: ContractorQuoteStatus; count: number }>;
    byWorkflowResult: Array<{ result: WorkflowResult; count: number }>;
  };
  trend: { points: Array<{ date: string; created: number; completed: number }> };
  categoryBreakdown: Array<{ category: MaintenanceCategory; count: number }>;
  priorityBreakdown: Array<{ priority: MaintenancePriority; count: number }>;
  averageResolutionHours: number | null;
  recentActivity: Prisma.ActivityEventGetPayload<object>[];
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

function getPeriodRange(
  period: DashboardPeriod,
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  const days = period === '7d' ? 7 : 30;
  return { periodStart: new Date(now.getTime() - days * DAY_MS), periodEnd: now };
}

/** UTC calendar-day boundaries for the trend chart — a one-day-boundary
 * simplification vs. the exact rolling `periodStart`/`periodEnd` used
 * elsewhere, purely so the chart has clean, whole-day buckets. */
function utcDayRange(days: number, now: Date): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
  return { start, end };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `undefined` when unrestricted (org staff), an `{in: [...]}` filter
 * fragment otherwise — spread into any `where` clause below. */
function propertyScope(
  propertyIds: AccessibleProperties,
): { propertyId: { in: string[] } } | object {
  return propertyIds === 'ALL' ? {} : { propertyId: { in: propertyIds } };
}

export class DashboardService {
  private readonly activityService: ActivityService;
  private readonly authz: AuthorizationService;

  constructor(private readonly prisma: PrismaClient) {
    this.activityService = new ActivityService(prisma);
    this.authz = new AuthorizationService(prisma);
  }

  async getDashboard(
    organisationId: string,
    auth: AuthContext,
    query: DashboardQuery,
  ): Promise<DashboardResponse> {
    const now = new Date();
    const { periodStart, periodEnd } = getPeriodRange(query.period, now);
    const propertyIds = await this.authz.getAccessiblePropertyIds(auth, 'analytics.view');

    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { id: true, name: true },
    });

    // A property-scoped manager with zero accessible properties still gets
    // a well-formed, all-zero dashboard — never an error, never someone
    // else's data.
    if (propertyIds !== 'ALL' && propertyIds.length === 0) {
      return this.emptyDashboard(query, periodStart, periodEnd, organisation);
    }

    const scopedPropertyIds = propertyIds === 'ALL' ? undefined : propertyIds;

    const [
      metrics,
      portfolio,
      requestsSnapshot,
      workOrdersSnapshot,
      quotesSnapshot,
      trend,
      breakdowns,
      averageResolutionHours,
      attention,
      recentActivityResult,
    ] = await Promise.all([
      this.getMetrics(organisationId, propertyIds, periodStart, periodEnd),
      this.getPortfolio(organisationId, propertyIds),
      this.getRequestsSnapshot(organisationId, propertyIds),
      this.getWorkOrdersSnapshot(organisationId, propertyIds),
      this.getQuotesSnapshot(organisationId, propertyIds),
      this.getTrend(organisationId, propertyIds, query.period, now),
      this.getCategoryAndPriorityBreakdown(organisationId, propertyIds),
      this.getAverageResolutionHours(organisationId, propertyIds, periodStart, periodEnd),
      getAttentionItems(this.prisma, organisationId, now, scopedPropertyIds),
      this.activityService.listForOrganisation(
        organisationId,
        { page: 1, pageSize: 10 },
        scopedPropertyIds,
      ),
    ]);

    return {
      period: query.period,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      organisation,
      attention,
      metrics,
      portfolio,
      requestsSnapshot,
      workOrdersSnapshot,
      quotesSnapshot,
      trend,
      categoryBreakdown: breakdowns.categoryBreakdown,
      priorityBreakdown: breakdowns.priorityBreakdown,
      averageResolutionHours,
      recentActivity: recentActivityResult.items,
    };
  }

  private emptyDashboard(
    query: DashboardQuery,
    periodStart: Date,
    periodEnd: Date,
    organisation: { id: string; name: string },
  ): DashboardResponse {
    return {
      period: query.period,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      organisation,
      attention: { items: [], totalCount: 0, displayLimit: 8 },
      metrics: {
        openRequests: 0,
        activeWorkOrders: 0,
        completedThisPeriod: 0,
        pendingSignature: 0,
      },
      portfolio: {
        totalProperties: 0,
        totalSpaces: 0,
        occupiedSpaces: 0,
        vacantSpaces: 0,
        occupancyRatePct: 0,
      },
      requestsSnapshot: {
        byStatus: Object.values(MaintenanceRequestStatus).map((status) => ({ status, count: 0 })),
      },
      workOrdersSnapshot: {
        byStatus: Object.values(WorkOrderStatus).map((status) => ({ status, count: 0 })),
      },
      quotesSnapshot: {
        byStatus: Object.values(ContractorQuoteStatus).map((status) => ({ status, count: 0 })),
        byWorkflowResult: (
          [
            'NOT_REQUIRED',
            'PENDING',
            'COMPLETED',
            'REJECTED',
            'FAILED',
            'CANCELLED',
          ] as WorkflowResult[]
        ).map((result) => ({ result, count: 0 })),
      },
      trend: { points: [] },
      categoryBreakdown: Object.values(MaintenanceCategory).map((category) => ({
        category,
        count: 0,
      })),
      priorityBreakdown: Object.values(MaintenancePriority).map((priority) => ({
        priority,
        count: 0,
      })),
      averageResolutionHours: null,
      recentActivity: [],
    };
  }

  private async getMetrics(
    organisationId: string,
    propertyIds: AccessibleProperties,
    periodStart: Date,
    periodEnd: Date,
  ) {
    const scope = propertyScope(propertyIds);
    const [openRequests, activeWorkOrders, completedThisPeriod, pendingSignature] =
      await Promise.all([
        this.prisma.maintenanceRequest.count({
          where: { organisationId, status: { in: OPEN_REQUEST_STATUSES }, ...scope },
        }),
        this.prisma.workOrder.count({
          where: { organisationId, status: { in: ACTIVE_WORK_ORDER_STATUSES }, ...scope },
        }),
        this.prisma.workOrder.count({
          where: {
            organisationId,
            status: 'COMPLETED',
            completedAt: { gte: periodStart, lte: periodEnd },
            ...scope,
          },
        }),
        this.prisma.contractorQuote.count({
          where: {
            organisationId,
            workflowMode: { in: ['SIGNATURE_ONLY', 'APPROVAL_THEN_SIGNATURE'] },
            signatureStatus: { in: ['PENDING', 'PARTIALLY_SIGNED'] },
            ...(propertyIds === 'ALL' ? {} : { workOrder: { propertyId: { in: propertyIds } } }),
          },
        }),
      ]);
    return { openRequests, activeWorkOrders, completedThisPeriod, pendingSignature };
  }

  // Occupancy is derived from active TENANT/RESIDENT memberships — never
  // from Space.status, which covers unrelated operational states
  // (under maintenance, reserved). See src/lib/occupancy.ts, the single
  // source of truth for this already used elsewhere (e.g. property/space
  // detail pages) — reused here rather than reimplemented.
  private async getPortfolio(organisationId: string, propertyIds: AccessibleProperties) {
    const scope = propertyScope(propertyIds);
    const [totalProperties, spaceRows] = await Promise.all([
      this.prisma.property.count({
        where: { organisationId, ...(propertyIds === 'ALL' ? {} : { id: { in: propertyIds } }) },
      }),
      this.prisma.space.findMany({ where: { organisationId, ...scope }, select: { id: true } }),
    ]);
    const totalSpaces = spaceRows.length;
    const occupiedIds = await getOccupiedSpaceIds(
      this.prisma,
      spaceRows.map((s) => s.id),
    );
    const occupiedSpaces = occupiedIds.size;
    const vacantSpaces = totalSpaces - occupiedSpaces;
    const occupancyRatePct =
      totalSpaces === 0 ? 0 : Math.round((occupiedSpaces / totalSpaces) * 1000) / 10;
    return { totalProperties, totalSpaces, occupiedSpaces, vacantSpaces, occupancyRatePct };
  }

  private async getRequestsSnapshot(organisationId: string, propertyIds: AccessibleProperties) {
    const grouped = await this.prisma.maintenanceRequest.groupBy({
      by: ['status'],
      where: { organisationId, ...propertyScope(propertyIds) },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const byStatus = Object.values(MaintenanceRequestStatus).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
    }));
    return { byStatus };
  }

  private async getWorkOrdersSnapshot(organisationId: string, propertyIds: AccessibleProperties) {
    const grouped = await this.prisma.workOrder.groupBy({
      by: ['status'],
      where: { organisationId, ...propertyScope(propertyIds) },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const byStatus = Object.values(WorkOrderStatus).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
    }));
    return { byStatus };
  }

  private async getQuotesSnapshot(organisationId: string, propertyIds: AccessibleProperties) {
    const workOrderScope =
      propertyIds === 'ALL' ? {} : { workOrder: { propertyId: { in: propertyIds } } };
    const [grouped, forWorkflowResult] = await Promise.all([
      this.prisma.contractorQuote.groupBy({
        by: ['status'],
        where: { organisationId, ...workOrderScope },
        _count: { _all: true },
      }),
      this.prisma.contractorQuote.findMany({
        where: { organisationId, ...workOrderScope },
        select: { workflowMode: true, approvalStatus: true, signatureStatus: true },
      }),
    ]);

    const statusCounts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const byStatus = Object.values(ContractorQuoteStatus).map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
    }));

    const resultCounts = new Map<WorkflowResult, number>();
    for (const q of forWorkflowResult) {
      const result = deriveWorkflowResult(q.workflowMode, q.approvalStatus, q.signatureStatus);
      resultCounts.set(result, (resultCounts.get(result) ?? 0) + 1);
    }
    const ALL_RESULTS: WorkflowResult[] = [
      'NOT_REQUIRED',
      'PENDING',
      'COMPLETED',
      'REJECTED',
      'FAILED',
      'CANCELLED',
    ];
    const byWorkflowResult = ALL_RESULTS.map((result) => ({
      result,
      count: resultCounts.get(result) ?? 0,
    }));

    return { byStatus, byWorkflowResult };
  }

  private async getTrend(
    organisationId: string,
    propertyIds: AccessibleProperties,
    period: DashboardPeriod,
    now: Date,
  ) {
    const days = period === '7d' ? 7 : 30;
    const { start, end } = utcDayRange(days, now);
    const scope = propertyScope(propertyIds);

    const [created, resolved] = await Promise.all([
      this.prisma.maintenanceRequest.findMany({
        where: { organisationId, reportedAt: { gte: start, lte: end }, ...scope },
        select: { reportedAt: true },
      }),
      this.prisma.maintenanceRequest.findMany({
        where: { organisationId, resolvedAt: { gte: start, lte: end }, ...scope },
        select: { resolvedAt: true },
      }),
    ]);

    const buckets = new Map<string, { created: number; completed: number }>();
    for (let i = 0; i < days; i++) {
      buckets.set(dayKey(new Date(start.getTime() + i * DAY_MS)), { created: 0, completed: 0 });
    }
    for (const r of created) {
      const bucket = buckets.get(dayKey(r.reportedAt));
      if (bucket) bucket.created += 1;
    }
    for (const r of resolved) {
      if (!r.resolvedAt) continue;
      const bucket = buckets.get(dayKey(r.resolvedAt));
      if (bucket) bucket.completed += 1;
    }

    const points = [...buckets.entries()].map(([date, counts]) => ({ date, ...counts }));
    return { points };
  }

  private async getCategoryAndPriorityBreakdown(
    organisationId: string,
    propertyIds: AccessibleProperties,
  ) {
    const openWhere: Prisma.MaintenanceRequestWhereInput = {
      organisationId,
      status: { in: OPEN_REQUEST_STATUSES },
      ...propertyScope(propertyIds),
    };
    const [byCategoryRaw, byPriorityRaw] = await Promise.all([
      this.prisma.maintenanceRequest.groupBy({
        by: ['category'],
        where: openWhere,
        _count: { _all: true },
      }),
      this.prisma.maintenanceRequest.groupBy({
        by: ['priority'],
        where: openWhere,
        _count: { _all: true },
      }),
    ]);

    const categoryCounts = new Map(byCategoryRaw.map((c) => [c.category, c._count._all]));
    const categoryBreakdown = Object.values(MaintenanceCategory).map((category) => ({
      category,
      count: categoryCounts.get(category) ?? 0,
    }));

    const priorityCounts = new Map(byPriorityRaw.map((p) => [p.priority, p._count._all]));
    const priorityBreakdown = Object.values(MaintenancePriority).map((priority) => ({
      priority,
      count: priorityCounts.get(priority) ?? 0,
    }));

    return { categoryBreakdown, priorityBreakdown };
  }

  /** No native Prisma avg-of-date-diff exists, and this codebase has no raw
   * SQL precedent — a narrow select of just the two timestamp columns +
   * a JS reduce matches the existing PropertySummary precedent of computing
   * derived numbers in application code. */
  private async getAverageResolutionHours(
    organisationId: string,
    propertyIds: AccessibleProperties,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number | null> {
    const rows = await this.prisma.maintenanceRequest.findMany({
      where: {
        organisationId,
        status: { in: ['RESOLVED', 'CLOSED'] },
        resolvedAt: { gte: periodStart, lte: periodEnd },
        ...propertyScope(propertyIds),
      },
      select: { reportedAt: true, resolvedAt: true },
    });
    if (rows.length === 0) return null;

    const totalHours = rows.reduce(
      (sum, r) => sum + hoursBetween(r.reportedAt, r.resolvedAt as Date),
      0,
    );
    return Math.round((totalHours / rows.length) * 10) / 10;
  }
}
