import type { PrismaClient, PropertyRole } from '@prisma/client';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import {
  CAPABILITIES,
  type Capability,
  DEFAULT_ROLE_CAPABILITIES,
  ORG_MEMBER_LEGACY_CAPABILITIES,
  isCapability,
} from './capabilities.js';

/** `'ALL'` means "every property in the organisation" — returned for
 * OWNER/ADMIN (and MEMBER, for the capabilities it already had) so callers
 * never have to special-case "no filter" vs. "filter by this exact list". */
export type AccessibleProperties = 'ALL' | string[];

/**
 * The one place WaslProp answers "can(user, capability, propertyId?)".
 * Never scattered role checks in controllers/services — see this
 * module's role in the property-scoped-authorization milestone.
 *
 * Resolution order (conceptually: defaults -> org overrides -> membership
 * -> effective capability -> property scope):
 *
 * 1. OWNER/ADMIN (OrganisationMembership.role) — full organisation access,
 *    unchanged from pre-existing behaviour. PROPERTY_MANAGER/
 *    FACILITY_MANAGER are never treated as equivalent to this.
 * 2. MEMBER (OrganisationMembership.role) — exactly the read access MEMBER
 *    already had (every list/get route in these modules had no role check
 *    at all before this milestone) — see ORG_MEMBER_LEGACY_CAPABILITIES.
 *    Never broadened by this change.
 * 3. PropertyMembership — a user with no OrganisationMembership at all
 *    (pure property-scoped user, or a resident) is resolved via their
 *    PropertyContact's ACTIVE PropertyMembership rows. Each membership's
 *    role is resolved to an effective capability set (system default,
 *    overridden per-organisation by OrganisationRolePermission rows) and
 *    only applies to that membership's own propertyId — never the whole
 *    organisation.
 *
 * A user can hold multiple PropertyMemberships with different roles across
 * different properties (e.g. TENANT on A, PROPERTY_MANAGER on B) — each is
 * resolved independently; capabilities never leak from one property to
 * another.
 */
export class AuthorizationService {
  constructor(private readonly prisma: PrismaClient) {}

  /** System defaults for this role, with this organisation's overrides
   * (if any) applied. Only override rows that exist are queried — an
   * organisation that has never touched Roles & Permissions runs this at
   * zero extra rows. */
  async getEffectiveRoleCapabilities(
    organisationId: string,
    role: PropertyRole,
  ): Promise<Set<Capability>> {
    const capabilities = new Set<Capability>(DEFAULT_ROLE_CAPABILITIES[role]);
    const overrides = await this.prisma.organisationRolePermission.findMany({
      where: { organisationId, role },
      select: { capability: true, granted: true },
    });
    for (const override of overrides) {
      if (!isCapability(override.capability)) continue; // defensive — see capabilities.ts
      if (override.granted) capabilities.add(override.capability);
      else capabilities.delete(override.capability);
    }
    return capabilities;
  }

  /** Every property this contact has ACTIVE access to, and the union of
   * capabilities they hold on each (a contact can hold more than one
   * membership on the same property only in edge cases — capabilities
   * still just union, never conflict). Inactive/ended memberships grant
   * nothing, by construction (excluded from the query). */
  async getPropertyCapabilitiesForContact(
    organisationId: string,
    propertyContactId: string,
  ): Promise<Map<string, Set<Capability>>> {
    const memberships = await this.prisma.propertyMembership.findMany({
      where: { organisationId, contactId: propertyContactId, status: 'ACTIVE' },
      select: { propertyId: true, role: true },
    });

    const rolesUsed = [...new Set(memberships.map((m) => m.role))];
    const roleCapabilityEntries = await Promise.all(
      rolesUsed.map(
        async (role) =>
          [role, await this.getEffectiveRoleCapabilities(organisationId, role)] as const,
      ),
    );
    const roleCapabilities = new Map(roleCapabilityEntries);

    const result = new Map<string, Set<Capability>>();
    for (const membership of memberships) {
      const capsForRole = roleCapabilities.get(membership.role);
      if (!capsForRole || capsForRole.size === 0) continue;
      const existing = result.get(membership.propertyId) ?? new Set<Capability>();
      for (const cap of capsForRole) existing.add(cap);
      result.set(membership.propertyId, existing);
    }
    return result;
  }

  /** Boolean check. Omit `propertyId` for a coarse "does this user have
   * this capability anywhere" check (e.g. a route-entry gate before the
   * service layer does real per-row scoping via getAccessiblePropertyIds). */
  async can(auth: AuthContext, capability: Capability, propertyId?: string): Promise<boolean> {
    if (auth.orgRole === 'OWNER' || auth.orgRole === 'ADMIN') return true;
    if (auth.orgRole === 'MEMBER' && ORG_MEMBER_LEGACY_CAPABILITIES.has(capability)) return true;
    if (!auth.propertyContactId) return false;

    const byProperty = await this.getPropertyCapabilitiesForContact(
      auth.organisationId,
      auth.propertyContactId,
    );
    if (propertyId) return byProperty.get(propertyId)?.has(capability) ?? false;
    return [...byProperty.values()].some((caps) => caps.has(capability));
  }

  /** The portfolio-scoping primitive — every list/aggregate query (Section
   * "PORTFOLIO QUERY SCOPING") must filter through this, never trust a
   * caller-supplied propertyId as sufficient authorization on its own. */
  async getAccessiblePropertyIds(
    auth: AuthContext,
    capability: Capability,
  ): Promise<AccessibleProperties> {
    if (auth.orgRole === 'OWNER' || auth.orgRole === 'ADMIN') return 'ALL';
    if (auth.orgRole === 'MEMBER' && ORG_MEMBER_LEGACY_CAPABILITIES.has(capability)) return 'ALL';
    if (!auth.propertyContactId) return [];

    const byProperty = await this.getPropertyCapabilitiesForContact(
      auth.organisationId,
      auth.propertyContactId,
    );
    return [...byProperty.entries()]
      .filter(([, caps]) => caps.has(capability))
      .map(([propertyId]) => propertyId);
  }

  /** The union of every capability this user holds across every accessible
   * property (plus the full catalogue for OWNER/ADMIN, and the MEMBER
   * legacy set for MEMBER) — used to build capability-driven frontend
   * navigation. Never itself an authorization decision; the backend still
   * checks per-property on every request. */
  async getEffectiveCapabilitySummary(auth: AuthContext): Promise<Capability[]> {
    if (auth.orgRole === 'OWNER' || auth.orgRole === 'ADMIN') {
      return [...CAPABILITIES];
    }
    const result = new Set<Capability>();
    if (auth.orgRole === 'MEMBER') {
      for (const cap of ORG_MEMBER_LEGACY_CAPABILITIES) result.add(cap);
    }
    if (auth.propertyContactId) {
      const byProperty = await this.getPropertyCapabilitiesForContact(
        auth.organisationId,
        auth.propertyContactId,
      );
      for (const caps of byProperty.values()) {
        for (const cap of caps) result.add(cap);
      }
    }
    return [...result];
  }
}
