import type { MaintenanceRequestStatus, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { ContractorEligibilityService } from '../modules/contractors/compliance/eligibility.service.js';

/**
 * A deterministic, non-AI "Needs Your Attention" engine — schema-derived
 * item types only, each with its own age-based severity thresholds. Shared
 * between the org-wide dashboard (src/modules/dashboard/dashboard.service.ts)
 * and a single property's detail page (src/modules/properties/properties.service.ts),
 * via an optional `propertyIds` filter on every finder — never duplicated
 * between the two callers.
 */

export const OPEN_REQUEST_STATUSES: MaintenanceRequestStatus[] = [
  'NEW',
  'UNDER_REVIEW',
  'IN_PROGRESS',
];

const ATTENTION_HARD_CAP = 50;
const ATTENTION_DISPLAY_LIMIT = 8;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type AttentionSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type AttentionItemType =
  | 'URGENT_REQUEST_OPEN'
  | 'WORK_ORDER_OVERDUE_SCHEDULE'
  | 'QUOTE_SIGNATURE_STALLED'
  | 'QUOTE_PENDING_APPROVAL_TOO_LONG'
  | 'WORK_ORDER_STUCK_IN_DRAFT'
  | 'STALE_OPEN_REQUEST'
  | 'QUOTE_REJECTED_NEEDS_FOLLOWUP'
  | 'CONTRACTOR_CREDENTIAL_EXPIRED'
  | 'CONTRACTOR_CREDENTIAL_EXPIRING_SOON'
  | 'CONTRACTOR_CREDENTIAL_PENDING_VERIFICATION'
  | 'WORK_ORDER_CONTRACTOR_NO_LONGER_ELIGIBLE';

export interface AttentionItem {
  id: string;
  type: AttentionItemType;
  severity: AttentionSeverity;
  title: string;
  description: string;
  entityType: 'MaintenanceRequest' | 'WorkOrder' | 'ContractorQuote' | 'Contractor';
  entityId: string;
  /** Null for organisation-wide facts with no single property — a
   * contractor is an organisation-wide vendor (see Contractor's own doc
   * comment), so a credential expiring has no property to attach to. */
  propertyId: string | null;
  spaceId: string | null;
  occurredAt: string;
  actionLabel: string;
  actionUrl: string;
}

export interface AttentionResult {
  items: AttentionItem[];
  totalCount: number;
  displayLimit: number;
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export async function getAttentionItems(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionResult> {
  const results = await Promise.all([
    findUrgentRequestsOpen(prisma, organisationId, now, propertyIds),
    findWorkOrderOverdueSchedule(prisma, organisationId, now, propertyIds),
    findQuoteSignatureStalled(prisma, organisationId, now, propertyIds),
    findQuotePendingApprovalTooLong(prisma, organisationId, now, propertyIds),
    findWorkOrderStuckInDraft(prisma, organisationId, now, propertyIds),
    findStaleOpenRequests(prisma, organisationId, now, propertyIds),
    findQuoteRejectedNeedsFollowup(prisma, organisationId, now, propertyIds),
    // Contractors are an organisation-wide vendor directory (no propertyId
    // — see Contractor's own doc comment), so these facts only make sense
    // for a caller with unrestricted (org-wide) visibility — a
    // property-scoped manager's portfolio dashboard never includes them,
    // matching the same coarse-visibility precedent already documented for
    // contractors.view/manage.
    ...(propertyIds === undefined
      ? [
          findContractorCredentialsExpired(prisma, organisationId, now),
          findContractorCredentialsExpiringSoon(prisma, organisationId, now),
          findContractorCredentialsPendingVerification(prisma, organisationId, now),
          findWorkOrderContractorNoLongerEligible(prisma, organisationId, now),
        ]
      : []),
  ]);

  const severityRank: Record<AttentionSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  const typeRank: Record<AttentionItemType, number> = {
    URGENT_REQUEST_OPEN: 0,
    WORK_ORDER_OVERDUE_SCHEDULE: 1,
    QUOTE_SIGNATURE_STALLED: 2,
    QUOTE_PENDING_APPROVAL_TOO_LONG: 3,
    WORK_ORDER_STUCK_IN_DRAFT: 4,
    STALE_OPEN_REQUEST: 5,
    QUOTE_REJECTED_NEEDS_FOLLOWUP: 6,
    WORK_ORDER_CONTRACTOR_NO_LONGER_ELIGIBLE: 7,
    CONTRACTOR_CREDENTIAL_EXPIRED: 8,
    CONTRACTOR_CREDENTIAL_EXPIRING_SOON: 9,
    CONTRACTOR_CREDENTIAL_PENDING_VERIFICATION: 10,
  };

  const all = results.flat();
  all.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      typeRank[a.type] - typeRank[b.type] ||
      new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );

  return {
    items: all.slice(0, ATTENTION_HARD_CAP),
    totalCount: all.length,
    displayLimit: ATTENTION_DISPLAY_LIMIT,
  };
}

async function findUrgentRequestsOpen(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.maintenanceRequest.findMany({
    where: {
      organisationId,
      priority: 'URGENT',
      status: { in: OPEN_REQUEST_STATUSES },
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
    },
    select: { id: true, title: true, propertyId: true, spaceId: true, reportedAt: true },
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    const ageHours = hoursBetween(r.reportedAt, now);
    if (ageHours <= 4) continue;
    items.push({
      id: `URGENT_REQUEST_OPEN:${r.id}`,
      type: 'URGENT_REQUEST_OPEN',
      severity: ageHours > 24 ? 'CRITICAL' : 'WARNING',
      title: `Urgent request still open: ${r.title}`,
      description: `Reported ${formatAge(ageHours)} ago and still not resolved.`,
      entityType: 'MaintenanceRequest',
      entityId: r.id,
      propertyId: r.propertyId,
      spaceId: r.spaceId,
      occurredAt: r.reportedAt.toISOString(),
      actionLabel: 'View request',
      actionUrl: `/operations/requests/${r.id}`,
    });
  }
  return items;
}

async function findStaleOpenRequests(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.maintenanceRequest.findMany({
    where: {
      organisationId,
      priority: { not: 'URGENT' },
      status: { in: OPEN_REQUEST_STATUSES },
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
    },
    select: { id: true, title: true, propertyId: true, spaceId: true, reportedAt: true },
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    const ageHours = hoursBetween(r.reportedAt, now);
    if (ageHours <= 7 * 24) continue;
    items.push({
      id: `STALE_OPEN_REQUEST:${r.id}`,
      type: 'STALE_OPEN_REQUEST',
      severity: 'WARNING',
      title: `Open for over a week: ${r.title}`,
      description: `Reported ${formatAge(ageHours)} ago and still open.`,
      entityType: 'MaintenanceRequest',
      entityId: r.id,
      propertyId: r.propertyId,
      spaceId: r.spaceId,
      occurredAt: r.reportedAt.toISOString(),
      actionLabel: 'View request',
      actionUrl: `/operations/requests/${r.id}`,
    });
  }
  return items;
}

async function findWorkOrderStuckInDraft(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.workOrder.findMany({
    where: {
      organisationId,
      status: 'DRAFT',
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
    },
    select: { id: true, title: true, propertyId: true, spaceId: true, createdAt: true },
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    const ageHours = hoursBetween(r.createdAt, now);
    if (ageHours <= 3 * 24) continue;
    items.push({
      id: `WORK_ORDER_STUCK_IN_DRAFT:${r.id}`,
      type: 'WORK_ORDER_STUCK_IN_DRAFT',
      severity: ageHours > 7 * 24 ? 'CRITICAL' : 'WARNING',
      title: `Work order stuck in Draft: ${r.title}`,
      description: `Created ${formatAge(ageHours)} ago and not yet released.`,
      entityType: 'WorkOrder',
      entityId: r.id,
      propertyId: r.propertyId,
      spaceId: r.spaceId,
      occurredAt: r.createdAt.toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${r.id}`,
    });
  }
  return items;
}

async function findWorkOrderOverdueSchedule(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.workOrder.findMany({
    where: {
      organisationId,
      status: 'SCHEDULED',
      scheduledAt: { lt: now },
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
    },
    select: { id: true, title: true, propertyId: true, spaceId: true, scheduledAt: true },
  });

  return rows.map((r) => {
    const overdueHours = hoursBetween(r.scheduledAt as Date, now);
    return {
      id: `WORK_ORDER_OVERDUE_SCHEDULE:${r.id}`,
      type: 'WORK_ORDER_OVERDUE_SCHEDULE' as const,
      severity: overdueHours >= 48 ? ('CRITICAL' as const) : ('WARNING' as const),
      title: `Scheduled work overdue: ${r.title}`,
      description: `Was scheduled ${formatAge(overdueHours)} ago and hasn't started.`,
      entityType: 'WorkOrder' as const,
      entityId: r.id,
      propertyId: r.propertyId,
      spaceId: r.spaceId,
      occurredAt: (r.scheduledAt as Date).toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${r.id}`,
    };
  });
}

async function findQuotePendingApprovalTooLong(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.contractorQuote.findMany({
    where: {
      organisationId,
      approvalStatus: 'PENDING',
      workflowMode: { in: ['APPROVAL_ONLY', 'APPROVAL_THEN_SIGNATURE'] },
      // The approval workflow only ever runs on an awarded quote (see
      // QuotesService.assertAwarded) — this filter just makes that
      // guarantee explicit for the query itself.
      workOrderId: { not: null },
      ...(propertyIds ? { workOrder: { propertyId: { in: propertyIds } } } : {}),
    },
    select: {
      id: true,
      submittedAt: true,
      createdAt: true,
      workOrder: { select: { id: true, title: true, propertyId: true, spaceId: true } },
    },
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    if (!r.workOrder) continue;
    const since = r.submittedAt ?? r.createdAt;
    const ageHours = hoursBetween(since, now);
    if (ageHours <= 3 * 24) continue;
    items.push({
      id: `QUOTE_PENDING_APPROVAL_TOO_LONG:${r.id}`,
      type: 'QUOTE_PENDING_APPROVAL_TOO_LONG',
      severity: ageHours > 7 * 24 ? 'CRITICAL' : 'WARNING',
      title: `Quote awaiting approval: ${r.workOrder.title}`,
      description: `Submitted for approval ${formatAge(ageHours)} ago.`,
      entityType: 'ContractorQuote',
      entityId: r.id,
      propertyId: r.workOrder.propertyId,
      spaceId: r.workOrder.spaceId,
      occurredAt: since.toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${r.workOrder.id}`,
    });
  }
  return items;
}

async function findQuoteSignatureStalled(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const rows = await prisma.contractorQuote.findMany({
    where: {
      organisationId,
      signatureStatus: { in: ['PENDING', 'PARTIALLY_SIGNED'] },
      OR: [
        { workflowMode: 'SIGNATURE_ONLY' },
        { workflowMode: 'APPROVAL_THEN_SIGNATURE', approvalStatus: 'APPROVED' },
      ],
      workOrderId: { not: null },
      ...(propertyIds ? { workOrder: { propertyId: { in: propertyIds } } } : {}),
    },
    select: {
      id: true,
      submittedAt: true,
      createdAt: true,
      signatureStatus: true,
      workOrder: { select: { id: true, title: true, propertyId: true, spaceId: true } },
    },
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    if (!r.workOrder) continue;
    const since = r.submittedAt ?? r.createdAt;
    const ageHours = hoursBetween(since, now);
    // Someone is actively waiting on a co-signer once one side has already
    // signed — that deserves a tighter threshold than a signature nobody
    // has touched yet.
    const isPartial = r.signatureStatus === 'PARTIALLY_SIGNED';
    const warnAtDays = isPartial ? 1 : 3;
    const critAtDays = isPartial ? 5 : 7;
    const ageDays = ageHours / 24;
    if (ageDays <= warnAtDays) continue;
    items.push({
      id: `QUOTE_SIGNATURE_STALLED:${r.id}`,
      type: 'QUOTE_SIGNATURE_STALLED',
      severity: ageDays > critAtDays ? 'CRITICAL' : 'WARNING',
      title: `Signature stalled: ${r.workOrder.title}`,
      description: isPartial
        ? `Partially signed ${formatAge(ageHours)} ago — still waiting on the other signer.`
        : `Sent for signature ${formatAge(ageHours)} ago with no signatures yet.`,
      entityType: 'ContractorQuote',
      entityId: r.id,
      propertyId: r.workOrder.propertyId,
      spaceId: r.workOrder.spaceId,
      occurredAt: since.toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${r.workOrder.id}`,
    });
  }
  return items;
}

async function findQuoteRejectedNeedsFollowup(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
  propertyIds?: string[],
): Promise<AttentionItem[]> {
  const cutoff = new Date(now.getTime() - 14 * DAY_MS);
  const rejected = await prisma.contractorQuote.findMany({
    where: {
      organisationId,
      status: 'REJECTED',
      rejectedAt: { gte: cutoff },
      // REJECTED only ever happens via the approval workflow, which only
      // ever runs on an awarded quote — see assertAwarded.
      workOrderId: { not: null },
      ...(propertyIds ? { workOrder: { propertyId: { in: propertyIds } } } : {}),
    },
    select: {
      id: true,
      rejectedAt: true,
      createdAt: true,
      workOrderId: true,
      workOrder: { select: { id: true, title: true, propertyId: true, spaceId: true } },
    },
  });
  if (rejected.length === 0) return [];

  // Only flag it if no newer quote has since been requested for the same
  // work order — a superseded rejection doesn't need a nudge.
  const workOrderIds = [...new Set(rejected.map((r) => r.workOrderId as string))];
  const allQuotesForThoseWorkOrders = await prisma.contractorQuote.findMany({
    where: { workOrderId: { in: workOrderIds } },
    select: { workOrderId: true, createdAt: true },
  });
  const latestCreatedAtByWorkOrder = new Map<string, number>();
  for (const q of allQuotesForThoseWorkOrders) {
    if (!q.workOrderId) continue;
    const t = q.createdAt.getTime();
    const current = latestCreatedAtByWorkOrder.get(q.workOrderId) ?? -Infinity;
    if (t > current) latestCreatedAtByWorkOrder.set(q.workOrderId, t);
  }

  const items: AttentionItem[] = [];
  for (const r of rejected) {
    if (!r.workOrder || !r.workOrderId) continue;
    if (latestCreatedAtByWorkOrder.get(r.workOrderId) !== r.createdAt.getTime()) continue;
    items.push({
      id: `QUOTE_REJECTED_NEEDS_FOLLOWUP:${r.id}`,
      type: 'QUOTE_REJECTED_NEEDS_FOLLOWUP',
      severity: 'WARNING',
      title: `Quote rejected: ${r.workOrder.title}`,
      description: 'This quote was rejected and no replacement quote has been requested yet.',
      entityType: 'ContractorQuote',
      entityId: r.id,
      propertyId: r.workOrder.propertyId,
      spaceId: r.workOrder.spaceId,
      occurredAt: (r.rejectedAt as Date).toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${r.workOrder.id}`,
    });
  }
  return items;
}

async function findContractorCredentialsExpired(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
): Promise<AttentionItem[]> {
  const rows = await prisma.contractorCredential.findMany({
    where: { organisationId, verificationStatus: 'VERIFIED', expiresAt: { lt: now } },
    select: {
      id: true,
      type: true,
      expiresAt: true,
      contractor: { select: { id: true, name: true } },
    },
    take: ATTENTION_HARD_CAP,
  });

  return rows.map((r) => ({
    id: `CONTRACTOR_CREDENTIAL_EXPIRED:${r.id}`,
    type: 'CONTRACTOR_CREDENTIAL_EXPIRED' as const,
    severity: 'CRITICAL' as const,
    title: `${r.contractor.name}'s ${r.type} has expired`,
    description: `Expired ${formatAge(hoursBetween(r.expiresAt as Date, now))} ago.`,
    entityType: 'Contractor' as const,
    entityId: r.contractor.id,
    propertyId: null,
    spaceId: null,
    occurredAt: (r.expiresAt as Date).toISOString(),
    actionLabel: 'View contractor',
    actionUrl: `/contractors/${r.contractor.id}`,
  }));
}

async function findContractorCredentialsExpiringSoon(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
): Promise<AttentionItem[]> {
  const warnAt = new Date(now.getTime() + env.CREDENTIAL_EXPIRING_SOON_DAYS * DAY_MS);
  const rows = await prisma.contractorCredential.findMany({
    where: {
      organisationId,
      verificationStatus: 'VERIFIED',
      expiresAt: { gte: now, lte: warnAt },
    },
    select: {
      id: true,
      type: true,
      expiresAt: true,
      contractor: { select: { id: true, name: true } },
    },
    take: ATTENTION_HARD_CAP,
  });

  return rows.map((r) => {
    const daysLeft = Math.max(0, Math.round(hoursBetween(now, r.expiresAt as Date) / 24));
    return {
      id: `CONTRACTOR_CREDENTIAL_EXPIRING_SOON:${r.id}`,
      type: 'CONTRACTOR_CREDENTIAL_EXPIRING_SOON' as const,
      severity: daysLeft <= 7 ? ('WARNING' as const) : ('INFO' as const),
      title: `${r.contractor.name}'s ${r.type} expires soon`,
      description: `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
      entityType: 'Contractor' as const,
      entityId: r.contractor.id,
      propertyId: null,
      spaceId: null,
      occurredAt: now.toISOString(),
      actionLabel: 'View contractor',
      actionUrl: `/contractors/${r.contractor.id}`,
    };
  });
}

async function findContractorCredentialsPendingVerification(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
): Promise<AttentionItem[]> {
  const rows = await prisma.contractorCredential.findMany({
    where: { organisationId, verificationStatus: 'PENDING' },
    select: {
      id: true,
      type: true,
      createdAt: true,
      contractor: { select: { id: true, name: true } },
    },
    take: ATTENTION_HARD_CAP,
  });

  const items: AttentionItem[] = [];
  for (const r of rows) {
    const ageHours = hoursBetween(r.createdAt, now);
    // A brief grace period — no need to flag a credential someone uploaded
    // an hour ago as something needing attention yet.
    if (ageHours <= 48) continue;
    items.push({
      id: `CONTRACTOR_CREDENTIAL_PENDING_VERIFICATION:${r.id}`,
      type: 'CONTRACTOR_CREDENTIAL_PENDING_VERIFICATION',
      severity: 'WARNING',
      title: `${r.contractor.name}'s ${r.type} is awaiting verification`,
      description: `Provided ${formatAge(ageHours)} ago and not yet reviewed.`,
      entityType: 'Contractor',
      entityId: r.contractor.id,
      propertyId: null,
      spaceId: null,
      occurredAt: r.createdAt.toISOString(),
      actionLabel: 'View contractor',
      actionUrl: `/contractors/${r.contractor.id}`,
    });
  }
  return items;
}

/**
 * A contractor's compliance can lapse *after* they were assigned (a
 * policy expires, a licence is rejected on review) — this catches a
 * still-open or upcoming work order whose assigned contractor is no
 * longer eligible for it right now, which nothing else in this engine
 * would surface (assignment itself was validated at the time, not since).
 * Capped and scoped to SCHEDULED/IN_PROGRESS only (genuinely upcoming/
 * active work, not every historical DRAFT) to keep this bounded.
 */
async function findWorkOrderContractorNoLongerEligible(
  prisma: PrismaClient,
  organisationId: string,
  now: Date,
): Promise<AttentionItem[]> {
  const candidates = await prisma.workOrder.findMany({
    where: {
      organisationId,
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      contractorId: { not: null },
    },
    select: {
      id: true,
      title: true,
      propertyId: true,
      spaceId: true,
      contractorId: true,
      maintenanceRequest: { select: { category: true } },
    },
    take: ATTENTION_HARD_CAP,
  });
  if (candidates.length === 0) return [];

  const eligibilityService = new ContractorEligibilityService(prisma);
  const items: AttentionItem[] = [];
  for (const wo of candidates) {
    if (!wo.contractorId) continue;
    const result = await eligibilityService.evaluate(
      organisationId,
      wo.contractorId,
      wo.maintenanceRequest?.category ?? null,
    );
    if (result.eligible) continue;
    const reason = result.blockingIssues[0];
    items.push({
      id: `WORK_ORDER_CONTRACTOR_NO_LONGER_ELIGIBLE:${wo.id}`,
      type: 'WORK_ORDER_CONTRACTOR_NO_LONGER_ELIGIBLE',
      severity: 'CRITICAL',
      title: `Assigned contractor no longer eligible: ${wo.title}`,
      description: reason?.message ?? 'This contractor no longer meets a required compliance rule.',
      entityType: 'WorkOrder',
      entityId: wo.id,
      propertyId: wo.propertyId,
      spaceId: wo.spaceId,
      occurredAt: now.toISOString(),
      actionLabel: 'View work order',
      actionUrl: `/operations/work-orders/${wo.id}`,
    });
  }
  return items;
}
