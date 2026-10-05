import type { Prisma, PrismaClient, SpaceStrataClassification, StrataStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { recordActivity } from '../activity/activity.js';
import { assertOrganisationFeature } from '../organisations/organisation-features.js';
import {
  calculateEntitlementShare,
  calculateTotalUoe,
  reconcileUoe,
} from './strata.calculations.js';
import type {
  BulkSetLotsInput,
  ClassifySpacesInput,
  EnableStrataInput,
  ExistingLotEntry,
  NewLotEntry,
  UpdateStrataPlanInput,
} from './strata.schemas.js';

/** A lot number collision is enforced at the DB level (a partial unique
 * index on (propertyId, lotNumber) — see Space's schema.prisma doc
 * comment, since Prisma's own @@unique can't express the WHERE lotNumber
 * IS NOT NULL clause). Code-uniqueness is still pre-checked separately
 * before every write below, so by the time a P2002 reaches here it's
 * overwhelmingly the lot-number index — checked via the constraint name
 * Postgres reports in `meta.target`, never assumed blindly. */
function isLotNumberConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002' &&
    String((err as { meta?: { target?: unknown } }).meta?.target ?? '').includes('lotNumber')
  );
}

export interface StrataLotSummary {
  spaceId: string;
  name: string;
  code: string;
  lotNumber: string | null;
  unitsOfEntitlement: string;
  entitlementSharePct: number;
}

export interface UnclassifiedSpaceSummary {
  spaceId: string;
  name: string;
  code: string;
}

/**
 * A warning signal only, never a block — see the STRATA_RECONCILIATION_
 * MISMATCH schema doc comment. Fires once per mutating call whenever an
 * already-ACTIVE scheme's reconciliation is (or remains) mismatched
 * immediately after that mutation; never recomputes reconciliation
 * itself — every caller passes in the exact same object reconcileUoe (via
 * buildSummary, or a direct call for a non-StrataService mutator like
 * SpacesService) already produced, so this is purely "should I log a
 * warning," not a second implementation of the arithmetic.
 */
async function recordReconciliationMismatchIfNeeded(
  tx: Prisma.TransactionClient,
  params: { organisationId: string; propertyId: string; actorUserId: string; propertyName: string },
  reconciliation: StrataSummary['reconciliation'],
): Promise<void> {
  if (reconciliation.declaredTotal === null || reconciliation.isComplete !== false) return;
  const excess = (reconciliation.remaining ?? 0) < 0;
  await recordActivity(tx, {
    organisationId: params.organisationId,
    propertyId: params.propertyId,
    actorUserId: params.actorUserId,
    eventType: 'STRATA_RECONCILIATION_MISMATCH',
    entityType: 'Property',
    entityId: params.propertyId,
    title: `Entitlement allocation is no longer reconciled for ${params.propertyName}`,
    description: `Declared total ${reconciliation.declaredTotal}, allocated ${reconciliation.allocatedTotal}, ${
      excess
        ? `${Math.abs(reconciliation.remaining!)} in excess`
        : `${reconciliation.remaining} remaining`
    }.`,
  });
}

/**
 * Standalone counterpart of recordReconciliationMismatchIfNeeded for a
 * mutator that has no StrataSummary already in hand (SpacesService's
 * create/update) — still the one canonical reconcileUoe call, just
 * queried fresh rather than reusing a summary object that doesn't exist
 * on this path. A no-op for any property not currently ACTIVE, and for
 * one with no declared total to reconcile against.
 */
export async function checkStrataReconciliationDrift(
  tx: Prisma.TransactionClient,
  params: { organisationId: string; propertyId: string; actorUserId: string },
): Promise<void> {
  const property = await tx.property.findUnique({ where: { id: params.propertyId } });
  if (!property || property.strataStatus !== 'ACTIVE') return;

  const lots = await tx.space.findMany({
    where: { propertyId: params.propertyId, strataClassification: 'LOT' },
  });
  const reconciliation = reconcileUoe(
    lots.map((lot) => ({ unitsOfEntitlement: lot.entitlementValue?.toString() ?? '0' })),
    property.strataPlanDeclaredUnitsOfEntitlement?.toString() ?? null,
  );
  await recordReconciliationMismatchIfNeeded(
    tx,
    { ...params, propertyName: property.name },
    reconciliation,
  );
}

/**
 * The hard capacity gate for ADDING new strata allocation — a brand new
 * lot, or an existing non-lot space newly becoming one. Deliberately
 * distinct from recordReconciliationMismatchIfNeeded/
 * checkStrataReconciliationDrift's warning-only signal, which covers
 * EDITING an already-counted lot's own entitlement (even one that leaves
 * the total over/under, however large the change — see that function's
 * doc comment, and the tests proving an existing lot's UOE can always be
 * corrected on an ACTIVE scheme without being blocked). New capacity is
 * different: once a scheme is ACTIVE with a declared total, there is no
 * legitimate reason to allocate more of it than the registered Strata
 * Plan declares, so this throws rather than merely warning — the
 * reported bug this fixes is a user adding an 8th lot to a scheme already
 * reconciled at 7/7 lots and getting no feedback that doing so was wrong.
 *
 * A no-op for any property not currently ACTIVE (mirrors bulkSetLots'/
 * completeSetup's "never hard-block SAVING, only the final gate" design
 * during SETUP_IN_PROGRESS — see "reports an excess... when allocation
 * exceeds the declared total" for the test proving over-allocation is
 * still freely saveable pre-ACTIVE) or with no declared total to check
 * against. Checked against the CURRENT (pre-write) allocated total, not
 * a post-write recomputation — a single bulk request that both adds a
 * new lot AND reduces another lot's entitlement enough to compensate is
 * a known, narrow edge case this does not special-case; splitting that
 * into two separate saves (reduce, then add) is the documented workaround.
 */
export async function assertNewAllocationFits(
  tx: Prisma.TransactionClient,
  propertyId: string,
  newAllocationUoe: number,
): Promise<void> {
  if (newAllocationUoe <= 0) return;
  const property = await tx.property.findUnique({ where: { id: propertyId } });
  if (!property || property.strataStatus !== 'ACTIVE') return;
  if (property.strataPlanDeclaredUnitsOfEntitlement === null) return;

  const lots = await tx.space.findMany({
    where: { propertyId, strataClassification: 'LOT' },
    select: { entitlementValue: true },
  });
  const currentAllocatedTotal = calculateTotalUoe(
    lots.map((l) => ({ unitsOfEntitlement: l.entitlementValue?.toString() ?? '0' })),
  );
  const declaredTotal = Number(property.strataPlanDeclaredUnitsOfEntitlement);
  const projectedTotal = currentAllocatedTotal + newAllocationUoe;

  if (projectedTotal > declaredTotal) {
    const remainingCapacity = Math.max(0, declaredTotal - currentAllocatedTotal);
    const excess = projectedTotal - declaredTotal;
    throw new ConflictError(
      `This strata scheme's Units of Entitlement are already fully allocated: adding this would bring the total to ${projectedTotal} of the declared ${declaredTotal} (${excess} in excess). ${
        remainingCapacity > 0
          ? `Only ${remainingCapacity} unit${remainingCapacity === 1 ? '' : 's'} of entitlement remain.`
          : 'No entitlement remains to allocate.'
      } Reduce another lot's entitlement, or update the declared Units of Entitlement total, before adding this one.`,
      {
        declaredTotal,
        allocatedTotal: currentAllocatedTotal,
        requested: newAllocationUoe,
        remainingCapacity,
      },
    );
  }
}

export interface StrataSummary {
  strataStatus: StrataStatus;
  strataPlanNumber: string | null;
  strataSchemeName: string | null;
  strataPlanDeclaredUnitsOfEntitlement: string | null;
  lotCount: number;
  /** Spaces explicitly classified COMMON_PROPERTY (M11-B.1) — never counted
   * toward UOE or entitlement shares, but still a real, visible part of
   * the physical building. */
  commonPropertyCount: number;
  /** Existing Spaces on this property with no explicit strata
   * classification yet — expected/acceptable while SETUP_IN_PROGRESS,
   * never allowed once ACTIVE (see completeSetup). */
  unclassifiedCount: number;
  unclassifiedSpaces: UnclassifiedSpaceSummary[];
  totalUnitsOfEntitlement: number;
  reconciliation: {
    declaredTotal: number | null;
    allocatedTotal: number;
    remaining: number | null;
    isComplete: boolean | null;
  };
  lots: StrataLotSummary[];
}

/**
 * The single place that decides what a legacy, direct `isStrataManaged`
 * boolean write (PropertiesService.create/update, unchanged since M11-A)
 * means for the newer strataStatus lifecycle — see the M11-B.1 hardening
 * pass. This keeps the two fields from ever diverging into a
 * contradictory combination (isStrataManaged=true + strataStatus=
 * NOT_ENABLED, or isStrataManaged=false + strataStatus=ACTIVE) without
 * duplicating any lifecycle logic outside this module:
 *
 * - Setting it true mirrors `enable()`'s own NOT_ENABLED ->
 *   SETUP_IN_PROGRESS transition, and is a no-op for a property already
 *   past that point — it never jumps straight to ACTIVE, which still only
 *   ever happens via the deliberate `completeSetup()` step.
 * - Setting it false only ever resets a not-yet-committed
 *   (SETUP_IN_PROGRESS) scheme back to NOT_ENABLED. An ACTIVE scheme (real
 *   lots/UOE data attached) can never be disabled through this bare
 *   boolean — that would be exactly the "casual ON/OFF toggle that
 *   disconnects strata data" the original M11-B requirements forbid, and
 *   no destructive disable action exists yet regardless of entry point.
 *
 * Pure with one exception: throws ConflictError for the disallowed
 * ACTIVE -> false case, exactly like the validation already inline in
 * SpacesService/PropertiesService for other cross-field rules.
 */
export function resolveLegacyIsStrataManagedTransition(
  currentStatus: StrataStatus,
  desired: boolean,
): StrataStatus {
  if (desired) {
    return currentStatus === 'NOT_ENABLED' ? 'SETUP_IN_PROGRESS' : currentStatus;
  }
  if (currentStatus === 'ACTIVE') {
    throw new ConflictError(
      'Cannot disable strata management on an active scheme by unsetting isStrataManaged — no destructive disable action exists yet.',
    );
  }
  return 'NOT_ENABLED';
}

/**
 * The single place that reconciles a Space's legacy `isStrataLot` boolean
 * with the newer `strataClassification` (M11-B.1) — mirrors
 * resolveLegacyIsStrataManagedTransition's role for Property. A caller
 * that explicitly sends `strataClassification` always wins (it's the more
 * expressive, current field); a caller using only the legacy boolean gets
 * it mapped onto the classification exactly as that boolean has always
 * meant: true -> LOT, false -> drops out of LOT (back to UNCLASSIFIED,
 * never silently becoming COMMON_PROPERTY, since that's a positive
 * classification nothing in a bare boolean ever asserted). Neither input
 * touched -> classification is unchanged. Pure — never throws; the LOT
 * "requires lotNumber + positive UOE" rule and the ACTIVE-building
 * "new space must be explicitly classified" rule are validated separately
 * by the caller, since they depend on more than just these two fields.
 */
export function resolveSpaceClassification(
  current: SpaceStrataClassification,
  input: { isStrataLot?: boolean; strataClassification?: SpaceStrataClassification },
): SpaceStrataClassification {
  if (input.strataClassification !== undefined) {
    return input.strataClassification;
  }
  if (input.isStrataLot !== undefined) {
    if (input.isStrataLot) return 'LOT';
    return current === 'LOT' ? 'UNCLASSIFIED' : current;
  }
  return current;
}

/** A property that may also have existing, non-strata spaces — those are
 * never included in `lots` (only isStrataLot: true spaces represent an
 * actual UOE-bearing Lot/Unit). Spaces reused as lots are the SAME rows
 * that already carry maintenance/people/work-order history — see
 * bulkSetLots. */
export class StrataService {
  constructor(private readonly prisma: PrismaClient) {}

  private async getOwnedProperty(organisationId: string, propertyId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organisationId },
    });
    if (!property) {
      throw new NotFoundError('Property not found');
    }
    return property;
  }

  /** Good-UX pre-check for the DB-level partial unique index (see Space's
   * schema.prisma doc comment) — gives a clean, immediate error for the
   * common sequential case. The index itself, caught via isLotNumberConflict
   * at each actual write below, is what's authoritative for a genuine race
   * between two concurrent requests. */
  private async assertLotNumberAvailable(
    tx: Prisma.TransactionClient,
    propertyId: string,
    lotNumber: string | null | undefined,
    excludeSpaceId?: string,
  ) {
    if (!lotNumber) return;
    const clash = await tx.space.findFirst({
      where: { propertyId, lotNumber, ...(excludeSpaceId ? { NOT: { id: excludeSpaceId } } : {}) },
    });
    if (clash) {
      throw new ConflictError(
        `Lot number "${lotNumber}" is already used by another space on this property`,
      );
    }
  }

  async getSummary(organisationId: string, propertyId: string): Promise<StrataSummary> {
    await this.getOwnedProperty(organisationId, propertyId);
    return this.buildSummary(this.prisma, propertyId);
  }

  /**
   * Step 1 of the guided flow, and the only place NOT_ENABLED ->
   * SETUP_IN_PROGRESS happens. Idempotent for an already-enabled property
   * (re-saving the same step never regresses ACTIVE back to
   * SETUP_IN_PROGRESS) — always sets isStrataManaged=true, the same flag
   * SpacesService checks before allowing isStrataLot on any of this
   * property's spaces.
   */
  async enable(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: EnableStrataInput,
  ) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const property = await this.getOwnedProperty(organisationId, propertyId);
    const isFirstEnable = property.strataStatus === 'NOT_ENABLED';

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: {
          isStrataManaged: true,
          strataStatus: isFirstEnable ? 'SETUP_IN_PROGRESS' : property.strataStatus,
          ...input,
        },
      });

      if (isFirstEnable) {
        await recordActivity(tx, {
          organisationId,
          propertyId,
          actorUserId,
          eventType: 'STRATA_ENABLED',
          entityType: 'Property',
          entityId: propertyId,
          title: `Strata management enabled for ${updated.name}`,
        });
      }

      return updated;
    });
  }

  /** Update the Strata Plan's own fields — usable both mid-setup and later
   * (e.g. correcting the declared total after the fact). Requires strata
   * to have been enabled first (never implicitly enables). */
  async updatePlan(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: UpdateStrataPlanInput,
  ) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const property = await this.getOwnedProperty(organisationId, propertyId);
    if (property.strataStatus === 'NOT_ENABLED') {
      throw new ConflictError(
        'Enable strata management for this property before configuring its plan',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({ where: { id: propertyId }, data: input });

      await recordActivity(tx, {
        organisationId,
        propertyId,
        actorUserId,
        eventType: 'STRATA_PLAN_CONFIGURED',
        entityType: 'Property',
        entityId: propertyId,
        title: `Strata plan updated for ${updated.name}`,
      });

      return updated;
    });
  }

  /**
   * The wizard's "Lots & Units" step, and the general-purpose bulk lot
   * editor: for each entry with a `spaceId`, reuses that EXISTING Space —
   * never creates a duplicate row for it, so its maintenance/people/work
   * order/activity history stays intact (the M11-B "existing space -> lot
   * mapping" requirement). An entry with no `spaceId` creates a brand-new
   * Space via the same architecture a manager would use from the Spaces
   * tab, just marked as a lot immediately. One coarse activity event
   * per save, not one per lot.
   */
  async bulkSetLots(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: BulkSetLotsInput,
  ) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const property = await this.getOwnedProperty(organisationId, propertyId);
    if (property.strataStatus === 'NOT_ENABLED') {
      throw new ConflictError(
        'Enable strata management for this property before configuring its lots',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Capacity is checked BEFORE any entry is applied, against the sum
      // of only the entries that represent genuinely NEW allocation (a
      // brand-new lot, or an existing non-lot space becoming one for the
      // first time) — never an already-LOT space merely having its UOE
      // corrected, which stays unconditionally allowed. See
      // assertNewAllocationFits' doc comment.
      let newAllocationUoe = 0;
      for (const entry of input.lots) {
        if (entry.kind === 'new') {
          newAllocationUoe += entry.unitsOfEntitlement;
        } else {
          const existingSpace = await tx.space.findFirst({
            where: { id: entry.spaceId, organisationId, propertyId },
            select: { isStrataLot: true },
          });
          if (existingSpace && !existingSpace.isStrataLot) {
            newAllocationUoe += entry.unitsOfEntitlement;
          }
        }
      }
      await assertNewAllocationFits(tx, propertyId, newAllocationUoe);

      let updatedCount = 0;

      for (const entry of input.lots) {
        if (entry.kind === 'existing') {
          await this.applyExistingLot(tx, organisationId, propertyId, entry);
          updatedCount += 1;
        } else {
          await this.createNewLot(tx, organisationId, actorUserId, propertyId, entry);
        }
      }

      if (updatedCount > 0) {
        await recordActivity(tx, {
          organisationId,
          propertyId,
          actorUserId,
          eventType: 'STRATA_ENTITLEMENTS_UPDATED',
          entityType: 'Property',
          entityId: propertyId,
          title: `${updatedCount} lot${updatedCount === 1 ? '' : 's'} updated for ${property.name}`,
        });
      }

      const summary = await this.buildSummary(tx, propertyId);
      if (summary.strataStatus === 'ACTIVE') {
        await recordReconciliationMismatchIfNeeded(
          tx,
          { organisationId, propertyId, actorUserId, propertyName: property.name },
          summary.reconciliation,
        );
      }
      return summary;
    });
  }

  private async applyExistingLot(
    tx: Prisma.TransactionClient,
    organisationId: string,
    propertyId: string,
    entry: ExistingLotEntry,
  ) {
    const space = await tx.space.findFirst({
      where: { id: entry.spaceId, organisationId, propertyId },
    });
    if (!space) {
      throw new NotFoundError('Space not found');
    }
    await this.assertLotNumberAvailable(
      tx,
      propertyId,
      entry.lotNumber ?? space.lotNumber,
      space.id,
    );
    try {
      await tx.space.update({
        where: { id: space.id },
        data: {
          isStrataLot: true,
          strataClassification: 'LOT',
          lotNumber: entry.lotNumber ?? space.lotNumber,
          entitlementValue: entry.unitsOfEntitlement,
        },
      });
    } catch (err) {
      if (isLotNumberConflict(err)) {
        throw new ConflictError(
          `Lot number "${entry.lotNumber ?? space.lotNumber}" is already used by another space on this property`,
        );
      }
      throw err;
    }
  }

  private async createNewLot(
    tx: Prisma.TransactionClient,
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    entry: NewLotEntry,
  ) {
    const clash = await tx.space.findUnique({
      where: { propertyId_code: { propertyId, code: entry.code } },
    });
    if (clash) {
      throw new ConflictError(`A space with code "${entry.code}" already exists on this property`);
    }
    await this.assertLotNumberAvailable(tx, propertyId, entry.lotNumber);

    let space;
    try {
      space = await withPublicReference('LOT', (publicReference) =>
        tx.space.create({
          data: {
            organisationId,
            propertyId,
            publicReference,
            name: entry.name,
            code: entry.code,
            spaceType: entry.spaceType,
            isStrataLot: true,
            strataClassification: 'LOT',
            lotNumber: entry.lotNumber,
            entitlementValue: entry.unitsOfEntitlement,
          },
        }),
      );
    } catch (err) {
      if (isLotNumberConflict(err)) {
        throw new ConflictError(
          `Lot number "${entry.lotNumber}" is already used by another space on this property`,
        );
      }
      throw err;
    }

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
  }

  /**
   * Explicitly classifies EXISTING Spaces as a Lot/Unit or Common
   * Property/Area (M11-B.1) — the wizard's "classify existing spaces"
   * step, and the general reclassification action used any time
   * afterwards (including on an ACTIVE property — see Section 15's
   * reclassification-safety requirement). Never creates or deletes a
   * Space, never touches anything unrelated to it (maintenance/work
   * orders/memberships/activity all stay attached to the same row) —
   * only ever updates its classification and, for LOT, its lot number/
   * UOE. Reclassifying to COMMON_PROPERTY explicitly clears any stale lot
   * number/UOE so a space can never carry contradictory leftover data.
   * One coarse activity event per save.
   */
  async classifySpaces(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
    input: ClassifySpacesInput,
  ) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const property = await this.getOwnedProperty(organisationId, propertyId);
    if (property.strataStatus === 'NOT_ENABLED') {
      throw new ConflictError(
        'Enable strata management for this property before classifying its spaces',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Same pre-write capacity gate as bulkSetLots, for the same reason
      // — only entries reclassifying a space TO LOT for the first time
      // count as new allocation; re-confirming an already-LOT space as
      // LOT (to edit its UOE) never does.
      let newAllocationUoe = 0;
      for (const entry of input.entries) {
        if (entry.classification === 'LOT') {
          const existingSpace = await tx.space.findFirst({
            where: { id: entry.spaceId, organisationId, propertyId },
            select: { strataClassification: true },
          });
          if (existingSpace && existingSpace.strataClassification !== 'LOT') {
            newAllocationUoe += entry.unitsOfEntitlement;
          }
        }
      }
      await assertNewAllocationFits(tx, propertyId, newAllocationUoe);

      for (const entry of input.entries) {
        const space = await tx.space.findFirst({
          where: { id: entry.spaceId, organisationId, propertyId },
        });
        if (!space) {
          throw new NotFoundError('Space not found');
        }

        if (entry.classification === 'LOT') {
          await this.assertLotNumberAvailable(tx, propertyId, entry.lotNumber, space.id);
          try {
            await tx.space.update({
              where: { id: space.id },
              data: {
                strataClassification: 'LOT',
                isStrataLot: true,
                lotNumber: entry.lotNumber,
                entitlementValue: entry.unitsOfEntitlement,
              },
            });
          } catch (err) {
            if (isLotNumberConflict(err)) {
              throw new ConflictError(
                `Lot number "${entry.lotNumber}" is already used by another space on this property`,
              );
            }
            throw err;
          }
        } else {
          await tx.space.update({
            where: { id: space.id },
            data: {
              strataClassification: 'COMMON_PROPERTY',
              isStrataLot: false,
              lotNumber: null,
              entitlementValue: null,
            },
          });
        }
      }

      await recordActivity(tx, {
        organisationId,
        propertyId,
        actorUserId,
        eventType: 'STRATA_ENTITLEMENTS_UPDATED',
        entityType: 'Property',
        entityId: propertyId,
        title: `${input.entries.length} space${input.entries.length === 1 ? '' : 's'} classified for ${property.name}`,
      });

      const summary = await this.buildSummary(tx, propertyId);
      if (summary.strataStatus === 'ACTIVE') {
        await recordReconciliationMismatchIfNeeded(
          tx,
          { organisationId, propertyId, actorUserId, propertyName: property.name },
          summary.reconciliation,
        );
      }
      return summary;
    });
  }

  /**
   * The final "Enable" step. A stored plan number and at least one lot are
   * always required. Reconciliation against a *declared* Strata Plan total
   * (M11-B.1) is a hard gate ONLY when that declared total was actually
   * recorded — SUM(lot UOE) must then exactly equal it (via the same
   * deterministic reconcileUoe used everywhere else, never re-implemented
   * here) or this throws with the declared/allocated/remaining figures so
   * the caller can explain the discrepancy, and the property stays
   * SETUP_IN_PROGRESS — normal editing (saving progress, changing lots)
   * remains fully allowed regardless. When no declared total was ever
   * recorded, completing setup is unconstrained by allocation, matching
   * the pre-M11-B.1 behaviour and the "don't make entering 100+ lots
   * fragile" requirement. Every existing Space must also have been
   * explicitly classified (LOT or COMMON_PROPERTY) — see Section 7's
   * "once ACTIVE, there should not be silently unclassified Spaces"
   * invariant; the error names exactly which spaces still need it.
   */
  async completeSetup(organisationId: string, actorUserId: string, propertyId: string) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const property = await this.getOwnedProperty(organisationId, propertyId);
    if (property.strataStatus === 'NOT_ENABLED') {
      throw new ConflictError('Enable strata management for this property before completing setup');
    }
    if (!property.strataPlanNumber) {
      throw new ConflictError('Record a strata plan number before completing setup');
    }
    const lotCount = await this.prisma.space.count({ where: { propertyId, isStrataLot: true } });
    if (lotCount === 0) {
      throw new ConflictError('Add at least one lot before completing setup');
    }

    if (property.strataStatus === 'ACTIVE') {
      return property;
    }

    const summary = await this.buildSummary(this.prisma, propertyId);
    if (summary.unclassifiedCount > 0) {
      throw new ConflictError(
        `${summary.unclassifiedCount} space${summary.unclassifiedCount === 1 ? '' : 's'} still need${summary.unclassifiedCount === 1 ? 's' : ''} to be classified as a Lot/Unit or Common Property/Area before completing setup.`,
        { unclassifiedSpaces: summary.unclassifiedSpaces },
      );
    }
    const { declaredTotal, allocatedTotal, remaining, isComplete } = summary.reconciliation;
    if (declaredTotal !== null && isComplete === false) {
      const excess = (remaining ?? 0) < 0;
      throw new ConflictError(
        `Entitlement allocation is not yet reconciled: declared total ${declaredTotal}, allocated ${allocatedTotal}, ${
          excess ? `${Math.abs(remaining!)} in excess` : `${remaining} remaining`
        }. Adjust lot entitlements so they sum exactly to the declared total before completing setup.`,
        { declaredTotal, allocatedTotal, remaining },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: { strataStatus: 'ACTIVE' },
      });

      await recordActivity(tx, {
        organisationId,
        propertyId,
        actorUserId,
        eventType: 'STRATA_SETUP_COMPLETED',
        entityType: 'Property',
        entityId: propertyId,
        title: `Strata setup completed for ${updated.name}`,
      });

      return updated;
    });
  }

  private async buildSummary(
    client: PrismaClient | Prisma.TransactionClient,
    propertyId: string,
  ): Promise<StrataSummary> {
    const property = await client.property.findUniqueOrThrow({ where: { id: propertyId } });
    const spaces = await client.space.findMany({
      where: { propertyId },
      orderBy: { lotNumber: 'asc' },
    });

    const lots = spaces.filter((space) => space.strataClassification === 'LOT');
    const commonProperty = spaces.filter(
      (space) => space.strataClassification === 'COMMON_PROPERTY',
    );
    const unclassified = spaces.filter((space) => space.strataClassification === 'UNCLASSIFIED');

    const totalUnitsOfEntitlement = calculateTotalUoe(
      lots.map((lot) => ({ unitsOfEntitlement: lot.entitlementValue?.toString() ?? '0' })),
    );
    const reconciliation = reconcileUoe(
      lots.map((lot) => ({ unitsOfEntitlement: lot.entitlementValue?.toString() ?? '0' })),
      property.strataPlanDeclaredUnitsOfEntitlement?.toString() ?? null,
    );

    return {
      strataStatus: property.strataStatus,
      strataPlanNumber: property.strataPlanNumber,
      strataSchemeName: property.strataSchemeName,
      strataPlanDeclaredUnitsOfEntitlement:
        property.strataPlanDeclaredUnitsOfEntitlement?.toString() ?? null,
      lotCount: lots.length,
      commonPropertyCount: commonProperty.length,
      unclassifiedCount: unclassified.length,
      unclassifiedSpaces: unclassified.map((space) => ({
        spaceId: space.id,
        name: space.name,
        code: space.code,
      })),
      totalUnitsOfEntitlement,
      reconciliation,
      lots: lots.map((lot) => ({
        spaceId: lot.id,
        name: lot.name,
        code: lot.code,
        lotNumber: lot.lotNumber,
        unitsOfEntitlement: lot.entitlementValue?.toString() ?? '0',
        entitlementSharePct: calculateEntitlementShare(
          lot.entitlementValue?.toString() ?? '0',
          totalUnitsOfEntitlement,
        ),
      })),
    };
  }
}
