import type { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { recordActivity } from '../activity/activity.js';
import { getAttentionItems, OPEN_REQUEST_STATUSES } from '../../lib/attention-engine.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import type { PaginatedResult, PaginationQuery } from '../../lib/pagination.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { assertOrganisationFeature } from '../organisations/organisation-features.js';
import { resolveLegacyIsStrataManagedTransition } from '../strata/strata.service.js';
import type { CreatePropertyInput, UpdatePropertyInput } from './properties.schemas.js';

/** True when the input is trying to set/change any strata-specific field —
 * the trigger for the STRATA_MANAGEMENT feature check. A request that only
 * touches ordinary fields on an already-strata property never re-checks
 * the feature, matching how PATCH already only validates what it's asked
 * to change. */
function touchesStrataFields(input: CreatePropertyInput | UpdatePropertyInput): boolean {
  return (
    input.isStrataManaged !== undefined ||
    input.strataPlanNumber !== undefined ||
    input.strataSchemeName !== undefined
  );
}

export interface PropertySummary {
  spaces: number;
  occupied: number;
  vacant: number;
  people: number;
  peopleByRole: { owners: number; tenants: number; residents: number };
}

export interface PropertyInsights {
  metrics: { openRequests: number; averageResolutionHours: number | null };
  attention: Awaited<ReturnType<typeof getAttentionItems>>;
}

export class PropertiesService {
  private readonly authz: AuthorizationService;

  constructor(private readonly prisma: PrismaClient) {
    this.authz = new AuthorizationService(prisma);
  }

  async list(
    organisationId: string,
    auth: AuthContext,
    query: PaginationQuery,
  ): PaginatedPropertiesResult {
    const accessible = await this.authz.getAccessiblePropertyIds(auth, 'property.view');
    if (accessible !== 'ALL' && accessible.length === 0) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    }

    const where: Prisma.PropertyWhereInput = {
      organisationId,
      ...(accessible !== 'ALL' ? { id: { in: accessible } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.property.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { spaces: true } } },
      }),
      this.prisma.property.count({ where }),
    ]);

    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async create(organisationId: string, actorUserId: string, input: CreatePropertyInput) {
    if (touchesStrataFields(input)) {
      await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    }

    const clash = await this.prisma.property.findUnique({
      where: { organisationId_code: { organisationId, code: input.code } },
    });
    if (clash) {
      throw new ConflictError(`A property with code "${input.code}" already exists`);
    }

    // Keeps isStrataManaged and strataStatus from ever diverging (M11-B.1)
    // — a brand-new property has no prior status, so this is always
    // resolved against the implicit NOT_ENABLED default.
    const strataStatus =
      input.isStrataManaged !== undefined
        ? resolveLegacyIsStrataManagedTransition('NOT_ENABLED', input.isStrataManaged)
        : undefined;

    return this.prisma.$transaction(async (tx) => {
      const property = await withPublicReference('PROP', (publicReference) =>
        tx.property.create({
          data: {
            organisationId,
            publicReference,
            ...input,
            ...(strataStatus ? { strataStatus } : {}),
          },
        }),
      );

      await recordActivity(tx, {
        organisationId,
        propertyId: property.id,
        actorUserId,
        eventType: 'PROPERTY_CREATED',
        entityType: 'Property',
        entityId: property.id,
        title: `${property.name} created`,
      });

      return property;
    });
  }

  /**
   * Two independent ways in: an operational `property.view` capability
   * (org staff, or a property-scoped manager assigned to this property),
   * OR the caller simply being an ACTIVE member of this property in any
   * capacity — read-only self-view, the same access a resident/tenant has
   * always had for their own home (this endpoint previously had no
   * per-resource check at all, which let a resident view *any* property in
   * the org; this restores that resident-self-view while closing the
   * cross-property leak — see the property-role-authorization milestone).
   * Neither grants access to another property, staff or resident alike.
   */
  async getById(organisationId: string, auth: AuthContext, propertyId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
      include: { _count: { select: { spaces: true } } },
    });
    if (!property) {
      throw new NotFoundError('Property not found');
    }

    const hasOperationalAccess = await this.authz.can(auth, 'property.view', propertyId);
    const isOwnProperty =
      !hasOperationalAccess && auth.propertyContactId
        ? await this.prisma.propertyMembership
            .findFirst({
              where: { propertyId, contactId: auth.propertyContactId, status: 'ACTIVE' },
              select: { id: true },
            })
            .then(Boolean)
        : false;

    if (!hasOperationalAccess && !isOwnProperty) {
      throw new NotFoundError('Property not found');
    }

    const [occupiedSpaces, activeContacts, roleGroups] = await Promise.all([
      this.prisma.propertyMembership.findMany({
        where: {
          propertyId,
          role: { in: ['TENANT', 'RESIDENT'] },
          status: 'ACTIVE',
          spaceId: { not: null },
        },
        select: { spaceId: true },
        distinct: ['spaceId'],
      }),
      this.prisma.propertyMembership.findMany({
        where: { propertyId, status: 'ACTIVE' },
        select: { contactId: true },
        distinct: ['contactId'],
      }),
      this.prisma.propertyMembership.groupBy({
        by: ['role'],
        where: { propertyId, status: 'ACTIVE', role: { in: ['OWNER', 'TENANT', 'RESIDENT'] } },
        _count: { _all: true },
      }),
    ]);

    const spaces = property._count.spaces;
    const occupied = occupiedSpaces.length;
    const roleCounts = new Map(roleGroups.map((g) => [g.role, g._count._all]));

    const summary: PropertySummary = {
      spaces,
      occupied,
      vacant: spaces - occupied,
      people: activeContacts.length,
      peopleByRole: {
        owners: roleCounts.get('OWNER') ?? 0,
        tenants: roleCounts.get('TENANT') ?? 0,
        residents: roleCounts.get('RESIDENT') ?? 0,
      },
    };

    return { ...property, summary };
  }

  /**
   * Operational insights for one property's detail page — deliberately a
   * separate call from getById so the base property fetch (used by every
   * tab) stays cheap; only the Overview tab needs this. Reuses the shared
   * attention engine (src/lib/attention-engine.ts) with a propertyId filter
   * — the exact same rules as the org-wide dashboard, just scoped down.
   *
   * averageResolutionHours is all-time for this property (no period
   * selector on this page, unlike the org dashboard) — null, never 0, when
   * nothing has been resolved yet.
   */
  async getInsights(
    organisationId: string,
    propertyId: string,
    now: Date,
  ): Promise<PropertyInsights> {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
      select: { id: true },
    });
    if (!property) {
      throw new NotFoundError('Property not found');
    }

    const [openRequests, resolvedRows, attention] = await Promise.all([
      this.prisma.maintenanceRequest.count({
        where: { organisationId, propertyId, status: { in: OPEN_REQUEST_STATUSES } },
      }),
      this.prisma.maintenanceRequest.findMany({
        where: { organisationId, propertyId, status: { in: ['RESOLVED', 'CLOSED'] } },
        select: { reportedAt: true, resolvedAt: true },
      }),
      getAttentionItems(this.prisma, organisationId, now, [propertyId]),
    ]);

    const resolved = resolvedRows.filter((r) => r.resolvedAt);
    const averageResolutionHours =
      resolved.length === 0
        ? null
        : Math.round(
            (resolved.reduce(
              (sum, r) => sum + (r.resolvedAt!.getTime() - r.reportedAt.getTime()) / 3_600_000,
              0,
            ) /
              resolved.length) *
              10,
          ) / 10;

    return {
      metrics: { openRequests, averageResolutionHours },
      attention,
    };
  }

  async update(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: UpdatePropertyInput,
  ) {
    const existing = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
    });
    if (!existing) {
      throw new NotFoundError('Property not found');
    }

    if (touchesStrataFields(input)) {
      await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    }

    if (input.code) {
      const clash = await this.prisma.property.findFirst({
        where: { organisationId, code: input.code, NOT: { id: propertyId } },
      });
      if (clash) {
        throw new ConflictError(`A property with code "${input.code}" already exists`);
      }
    }

    // Keeps isStrataManaged and strataStatus from ever diverging (M11-B.1)
    // — resolved against this property's actual current status, so a
    // legacy caller can never independently create isStrataManaged=true +
    // strataStatus=NOT_ENABLED, or isStrataManaged=false + strataStatus=
    // ACTIVE. Throws if this update would disable an already-ACTIVE
    // scheme, since no destructive disable action exists yet.
    const strataStatus =
      input.isStrataManaged !== undefined
        ? resolveLegacyIsStrataManagedTransition(existing.strataStatus, input.isStrataManaged)
        : undefined;

    return this.prisma.$transaction(async (tx) => {
      const property = await tx.property.update({
        where: { id: propertyId },
        data: { ...input, ...(strataStatus ? { strataStatus } : {}) },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: property.id,
        actorUserId,
        eventType: 'PROPERTY_UPDATED',
        entityType: 'Property',
        entityId: property.id,
        title: `${property.name} updated`,
        description: `Updated: ${Object.keys(input).join(', ')}`,
      });

      return property;
    });
  }
}

type PaginatedPropertiesResult = Promise<
  PaginatedResult<Prisma.PropertyGetPayload<{ include: { _count: { select: { spaces: true } } } }>>
>;
