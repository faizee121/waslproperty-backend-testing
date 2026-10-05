import type { Prisma, PrismaClient, PropertyRole } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../../errors/AppError.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { Capability } from '../authorization/capabilities.js';

export type AudienceScope = 'ORGANISATION' | 'PROPERTY' | 'SPACE';

/** A structured targeting rule, not a frozen recipient list — always
 * re-resolved against current active memberships at send time, including
 * when reused via a SavedAudience, so a saved group never goes stale. */
export interface AudienceCriteria {
  scope: AudienceScope;
  propertyIds?: string[];
  spaceIds?: string[];
  roles?: PropertyRole[];
  /** Individual people added on top of the rule (or, with no other scope
   * restriction, the entire audience). */
  includeContactIds?: string[];
}

export interface ResolvedRecipient {
  contactId: string;
  userId: string | null;
  propertyId: string | null;
  spaceId: string | null;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AudiencePreview {
  count: number;
  /** Real, plain-language breakdown lines — e.g. "Darling Harbour Towers · Tenants" — never a fabricated summary. */
  summary: string;
}

export class AudienceResolver {
  constructor(private readonly prisma: PrismaClient) {}

  /** Confirms every id in the criteria genuinely belongs to this
   * organisation before it's ever used to resolve recipients. */
  async validate(organisationId: string, criteria: AudienceCriteria): Promise<void> {
    if (criteria.scope === 'PROPERTY' && criteria.propertyIds?.length) {
      const count = await this.prisma.property.count({
        where: { id: { in: criteria.propertyIds }, organisationId },
      });
      if (count !== new Set(criteria.propertyIds).size) {
        throw new NotFoundError('One or more selected properties were not found');
      }
    }

    if (criteria.scope === 'SPACE' && criteria.spaceIds?.length) {
      const count = await this.prisma.space.count({
        where: { id: { in: criteria.spaceIds }, organisationId },
      });
      if (count !== new Set(criteria.spaceIds).size) {
        throw new NotFoundError('One or more selected spaces were not found');
      }
    }

    if (criteria.includeContactIds?.length) {
      const count = await this.prisma.propertyContact.count({
        where: { id: { in: criteria.includeContactIds }, organisationId },
      });
      if (count !== new Set(criteria.includeContactIds).size) {
        throw new NotFoundError('One or more selected people were not found');
      }
    }
  }

  /** Resolves criteria to real, currently-active recipients — always
   * server-side. Never trusts a client-supplied recipient list. */
  async resolve(organisationId: string, criteria: AudienceCriteria): Promise<ResolvedRecipient[]> {
    const membershipWhere: Prisma.PropertyMembershipWhereInput = {
      organisationId,
      status: 'ACTIVE',
      contact: { status: 'ACTIVE' },
      ...(criteria.roles?.length ? { role: { in: criteria.roles } } : {}),
      ...(criteria.scope === 'PROPERTY' && criteria.propertyIds?.length
        ? { propertyId: { in: criteria.propertyIds } }
        : {}),
      ...(criteria.scope === 'SPACE' && criteria.spaceIds?.length
        ? { spaceId: { in: criteria.spaceIds } }
        : {}),
    };

    const memberships = await this.prisma.propertyMembership.findMany({
      where: membershipWhere,
      select: {
        propertyId: true,
        spaceId: true,
        contact: {
          select: { id: true, userId: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    const byContact = new Map<string, ResolvedRecipient>();
    for (const m of memberships) {
      if (byContact.has(m.contact.id)) continue;
      byContact.set(m.contact.id, {
        contactId: m.contact.id,
        userId: m.contact.userId,
        propertyId: m.propertyId,
        spaceId: m.spaceId,
        firstName: m.contact.firstName,
        lastName: m.contact.lastName,
        email: m.contact.email,
      });
    }

    if (criteria.includeContactIds?.length) {
      const extra = await this.prisma.propertyContact.findMany({
        where: { id: { in: criteria.includeContactIds }, organisationId, status: 'ACTIVE' },
        select: {
          id: true,
          userId: true,
          firstName: true,
          lastName: true,
          email: true,
          memberships: {
            where: { status: 'ACTIVE' },
            take: 1,
            orderBy: { createdAt: 'asc' },
            select: { propertyId: true, spaceId: true },
          },
        },
      });
      for (const c of extra) {
        if (byContact.has(c.id)) continue;
        byContact.set(c.id, {
          contactId: c.id,
          userId: c.userId,
          propertyId: c.memberships[0]?.propertyId ?? null,
          spaceId: c.memberships[0]?.spaceId ?? null,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
        });
      }
    }

    return [...byContact.values()];
  }

  async preview(organisationId: string, criteria: AudienceCriteria): Promise<AudiencePreview> {
    await this.validate(organisationId, criteria);
    const recipients = await this.resolve(organisationId, criteria);
    const summary = await this.describe(organisationId, criteria);
    return { count: recipients.length, summary };
  }

  /** A short, real, plain-language description of the scope — never a
   * fabricated statistic. Used both in the compose UI and the send
   * confirmation step. */
  private async describe(organisationId: string, criteria: AudienceCriteria): Promise<string> {
    const rolePart = criteria.roles?.length
      ? criteria.roles.map((r) => formatRoleLabel(r)).join(', ')
      : 'Everyone';

    if (criteria.scope === 'ORGANISATION') {
      return `Entire portfolio · ${rolePart}`;
    }

    if (criteria.scope === 'PROPERTY' && criteria.propertyIds?.length) {
      const properties = await this.prisma.property.findMany({
        where: { id: { in: criteria.propertyIds }, organisationId },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      const names = properties.map((p) => p.name).join(', ');
      return `${names} · ${rolePart}`;
    }

    if (criteria.scope === 'SPACE' && criteria.spaceIds?.length) {
      const spaces = await this.prisma.space.findMany({
        where: { id: { in: criteria.spaceIds }, organisationId },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      const names = spaces.map((s) => s.name).join(', ');
      return `${names} · ${rolePart}`;
    }

    return rolePart;
  }
}

/**
 * Shared by CommunicationsService and SavedAudiencesService — a
 * property-scoped user (portfolio manager, not organisation staff) can
 * never build/edit/send against an ORGANISATION-wide criteria, and every
 * PROPERTY/SPACE id named in the criteria must fall within properties they
 * actually hold `capability` on. Organisation staff (accessible === 'ALL')
 * are unrestricted, unchanged from pre-existing behaviour.
 */
export async function assertAudienceWithinScope(
  prisma: PrismaClient,
  authz: AuthorizationService,
  auth: AuthContext,
  capability: Capability,
  criteria: AudienceCriteria,
): Promise<void> {
  const accessible = await authz.getAccessiblePropertyIds(auth, capability);
  if (accessible === 'ALL') return;

  if (criteria.scope === 'ORGANISATION') {
    throw new ForbiddenError(
      'An organisation-wide announcement requires organisation staff access',
    );
  }
  if (criteria.scope === 'PROPERTY') {
    const outOfScope = (criteria.propertyIds ?? []).some((id) => !accessible.includes(id));
    if (outOfScope) {
      throw new ForbiddenError('You do not have access to one or more selected properties');
    }
  }
  if (criteria.scope === 'SPACE') {
    const spaceIds = criteria.spaceIds ?? [];
    // Tenant-scoped even though the downstream `accessible.includes(...)`
    // check below can never actually pass for a foreign-org space (its
    // propertyId can never appear in THIS org's `accessible` list) — the
    // authorization helper itself should never read across an
    // organisation boundary in the first place, regardless of what a
    // caller downstream happens to do with the result.
    const spaces = await prisma.space.findMany({
      where: { id: { in: spaceIds }, organisationId: auth.organisationId },
      select: { propertyId: true },
    });
    // A spaceId that doesn't resolve within this org at all (foreign org,
    // or simply doesn't exist) must be rejected exactly like one that
    // does but falls outside `accessible` — never silently ignored just
    // because the now-tenant-scoped query above didn't find it.
    const outOfScope =
      spaces.length !== spaceIds.length || spaces.some((s) => !accessible.includes(s.propertyId));
    if (outOfScope) {
      throw new ForbiddenError('You do not have access to one or more selected spaces');
    }
  }
}

function formatRoleLabel(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
