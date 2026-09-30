import type { Prisma, PrismaClient, SpaceStrataClassification } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import { getOccupiedSpaceIds, type Occupancy } from '../../lib/occupancy.js';
import type { PaginatedResult, PaginationQuery } from '../../lib/pagination.js';
import { assertOrganisationFeature } from '../organisations/organisation-features.js';
import { resolveSpaceClassification } from '../strata/strata.service.js';
import type { CreateSpaceInput, UpdateSpaceInput } from './spaces.schemas.js';

/** See PropertiesService's identically-named helper — same trigger
 * condition, mirrored here since Space has its own strata fields. */
function touchesStrataFields(input: CreateSpaceInput | UpdateSpaceInput): boolean {
  return (
    input.isStrataLot !== undefined ||
    input.lotNumber !== undefined ||
    input.entitlementValue !== undefined ||
    input.strataClassification !== undefined
  );
}

/** LOT requires a lot number and a positive UOE (M11-B.1, Section 4) —
 * enforced only when `strataClassification` was explicitly requested (the
 * new, expressive path). The legacy bare `isStrataLot` boolean predates
 * this rule and stays exactly as permissive as it always was, for
 * backward compatibility with M11-A data/callers. */
function assertLotHasRequiredFields(lotNumber: string | null | undefined, entitlementValue: unknown) {
  if (!lotNumber) {
    throw new ConflictError('A Lot/Unit requires a lot number');
  }
  if (entitlementValue === null || entitlementValue === undefined || Number(entitlementValue) <= 0) {
    throw new ConflictError('A Lot/Unit requires a positive Units of Entitlement value');
  }
}

export interface SpaceKeyPerson {
  id: string;
  firstName: string;
  lastName: string;
}

export interface SpaceKeyPeople {
  owners: SpaceKeyPerson[];
  tenants: SpaceKeyPerson[];
  residents: SpaceKeyPerson[];
}

export class SpacesService {
  constructor(private readonly prisma: PrismaClient) {}

  private async assertPropertyInOrg(organisationId: string, propertyId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
    });
    if (!property) {
      throw new NotFoundError('Property not found');
    }
    return property;
  }

  async listByProperty(
    organisationId: string,
    propertyId: string,
    query: PaginationQuery,
  ): Promise<
    PaginatedResult<
      Prisma.SpaceGetPayload<object> & { occupancy: Occupancy; occupantName: string | null }
    >
  > {
    await this.assertPropertyInOrg(organisationId, propertyId);

    const where: Prisma.SpaceWhereInput = {
      propertyId,
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
      this.prisma.space.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.space.count({ where }),
    ]);

    const spaceIds = items.map((space) => space.id);
    const [occupiedIds, occupantByOrder] = await Promise.all([
      getOccupiedSpaceIds(this.prisma, spaceIds),
      this.getPrimaryOccupantNames(spaceIds),
    ]);

    return {
      items: items.map((space) => ({
        ...space,
        occupancy: occupiedIds.has(space.id) ? 'OCCUPIED' : ('VACANT' as Occupancy),
        occupantName: occupantByOrder.get(space.id) ?? null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** One display name per space — the person a manager would call "the
   * current occupant". A TENANT or RESIDENT wins over an OWNER who doesn't
   * live there; ties within the same tier keep the earliest membership. */
  private async getPrimaryOccupantNames(spaceIds: string[]): Promise<Map<string, string>> {
    if (spaceIds.length === 0) return new Map();

    const memberships = await this.prisma.propertyMembership.findMany({
      where: {
        spaceId: { in: spaceIds },
        status: 'ACTIVE',
        role: { in: ['TENANT', 'RESIDENT', 'OWNER'] },
      },
      orderBy: { startDate: 'asc' },
      select: {
        spaceId: true,
        role: true,
        contact: { select: { firstName: true, lastName: true } },
      },
    });

    const roleRank: Record<string, number> = { TENANT: 0, RESIDENT: 0, OWNER: 1 };
    const best = new Map<string, { rank: number; name: string }>();
    for (const m of memberships) {
      if (!m.spaceId) continue;
      const rank = roleRank[m.role] ?? 2;
      const current = best.get(m.spaceId);
      if (!current || rank < current.rank) {
        best.set(m.spaceId, { rank, name: `${m.contact.firstName} ${m.contact.lastName}` });
      }
    }
    return new Map([...best.entries()].map(([spaceId, v]) => [spaceId, v.name]));
  }

  async create(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: CreateSpaceInput,
  ) {
    const property = await this.assertPropertyInOrg(organisationId, propertyId);

    let classification: SpaceStrataClassification = 'UNCLASSIFIED';
    if (touchesStrataFields(input)) {
      await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
      if (input.isStrataLot && !property.isStrataManaged) {
        throw new ConflictError(
          'This space cannot be marked a strata lot: its property is not configured as strata-managed',
        );
      }
      classification = resolveSpaceClassification('UNCLASSIFIED', input);
      if (classification === 'LOT' && input.strataClassification === 'LOT') {
        assertLotHasRequiredFields(input.lotNumber, input.entitlementValue);
      }
    }

    // A new Space in an ACTIVE strata scheme must be explicitly
    // classified — never silently left UNCLASSIFIED (M11-B.1, Section 7).
    // Backend-enforced, not just hidden in the UI.
    if (property.strataStatus === 'ACTIVE' && input.strataClassification === undefined) {
      throw new ConflictError(
        'This property is an active strata scheme — choose whether this new space is a Lot/Unit or Common Property/Area.',
      );
    }

    const clash = await this.prisma.space.findUnique({
      where: { propertyId_code: { propertyId, code: input.code } },
    });
    if (clash) {
      throw new ConflictError(`A space with code "${input.code}" already exists on this property`);
    }

    return this.prisma.$transaction(async (tx) => {
      const space = await tx.space.create({
        data: {
          organisationId,
          propertyId,
          ...input,
          strataClassification: classification,
          isStrataLot: classification === 'LOT',
        },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId,
        spaceId: space.id,
        actorUserId,
        eventType: 'SPACE_CREATED',
        entityType: 'Space',
        entityId: space.id,
        title: `${space.name} created`,
      });

      return space;
    });
  }

  async getById(organisationId: string, spaceId: string) {
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, organisationId },
      include: {
        property: {
          select: { id: true, name: true, code: true, isStrataManaged: true, strataStatus: true },
        },
      },
    });
    if (!space) {
      throw new NotFoundError('Space not found');
    }

    const activeMemberships = await this.prisma.propertyMembership.findMany({
      where: { spaceId, status: 'ACTIVE', role: { in: ['OWNER', 'TENANT', 'RESIDENT'] } },
      include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    });

    const keyPeople: SpaceKeyPeople = { owners: [], tenants: [], residents: [] };
    for (const membership of activeMemberships) {
      const person: SpaceKeyPerson = {
        id: membership.contact.id,
        firstName: membership.contact.firstName,
        lastName: membership.contact.lastName,
      };
      if (membership.role === 'OWNER') keyPeople.owners.push(person);
      else if (membership.role === 'TENANT') keyPeople.tenants.push(person);
      else if (membership.role === 'RESIDENT') keyPeople.residents.push(person);
    }

    const occupancy: Occupancy =
      keyPeople.tenants.length > 0 || keyPeople.residents.length > 0 ? 'OCCUPIED' : 'VACANT';

    return { ...space, occupancy, ...keyPeople };
  }

  async update(
    organisationId: string,
    actorUserId: string,
    spaceId: string,
    input: UpdateSpaceInput,
  ) {
    const existing = await this.prisma.space.findFirst({ where: { id: spaceId, organisationId } });
    if (!existing) {
      throw new NotFoundError('Space not found');
    }

    let classification = existing.strataClassification;
    if (touchesStrataFields(input)) {
      await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
      const wantsStrataLot = input.isStrataLot ?? existing.isStrataLot;
      if (wantsStrataLot) {
        const property = await this.prisma.property.findUniqueOrThrow({
          where: { id: existing.propertyId },
          select: { isStrataManaged: true },
        });
        if (!property.isStrataManaged) {
          throw new ConflictError(
            'This space cannot be marked a strata lot: its property is not configured as strata-managed',
          );
        }
      }
      classification = resolveSpaceClassification(existing.strataClassification, input);
      if (classification === 'LOT' && input.strataClassification === 'LOT') {
        assertLotHasRequiredFields(
          input.lotNumber ?? existing.lotNumber,
          input.entitlementValue ?? existing.entitlementValue,
        );
      }
    }

    if (input.code) {
      const clash = await this.prisma.space.findFirst({
        where: { propertyId: existing.propertyId, code: input.code, NOT: { id: spaceId } },
      });
      if (clash) {
        throw new ConflictError(
          `A space with code "${input.code}" already exists on this property`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const space = await tx.space.update({
        where: { id: spaceId },
        data: { ...input, strataClassification: classification, isStrataLot: classification === 'LOT' },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId: space.propertyId,
        spaceId: space.id,
        actorUserId,
        eventType: 'SPACE_UPDATED',
        entityType: 'Space',
        entityId: space.id,
        title: `${space.name} updated`,
        description: `Updated: ${Object.keys(input).join(', ')}`,
      });

      return space;
    });
  }
}
