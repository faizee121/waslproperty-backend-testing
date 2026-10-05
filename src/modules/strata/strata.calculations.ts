/**
 * Deterministic Units of Entitlement (UOE) math — the one place any strata
 * calculation happens (see the M11-B requirements: "do not scatter UOE
 * calculations through controllers/components"). No AI, no randomness, no
 * side effects; every function here is a pure transform of its inputs.
 *
 * Money-style "convert to integer, sum as integers" pattern, mirrored from
 * approval-policy.service.ts's toCents — UOE is stored as Decimal(12,2),
 * same shape as an amount, so the same technique avoids the same class of
 * floating-point summation error (0.1 + 0.2 !== 0.3) that would otherwise
 * creep in across 100+ lots.
 */

/** Decimal(12,2) -> integer hundredths, exactly like toCents for money. */
function toHundredths(value: number | string): number {
  return Math.round(Number(value) * 100);
}

/** integer hundredths -> a plain number with at most 2 decimal places. */
function fromHundredths(hundredths: number): number {
  return hundredths / 100;
}

export interface UoeLot {
  unitsOfEntitlement: number | string;
}

/** The building's calculated Total UOE — always SUM(Lot UOE), never a
 * separately edited figure (see Property.strataPlanDeclaredUnitsOfEntitlement's
 * own doc comment: that field is a reconciliation target, not this). */
export function calculateTotalUoe(lots: UoeLot[]): number {
  const totalHundredths = lots.reduce((sum, lot) => sum + toHundredths(lot.unitsOfEntitlement), 0);
  return fromHundredths(totalHundredths);
}

/** A single lot's entitlement share, as a percentage of the building's
 * calculated total — 0 when the total itself is 0 (no lots yet), never
 * NaN/Infinity. Full floating-point precision is kept; round only at the
 * point of display (see the M11-B example: 15/128 = 11.71875%, displayed
 * as "11.72%" — never round before dividing). */
export function calculateEntitlementShare(lotUoe: number | string, totalUoe: number): number {
  if (totalUoe <= 0) return 0;
  return (Number(lotUoe) / totalUoe) * 100;
}

export interface UoeReconciliation {
  /** The Strata Plan's declared total, or null if none has been recorded
   * yet — reconciliation is meaningless without it. */
  declaredTotal: number | null;
  /** Always SUM(Lot UOE) — see calculateTotalUoe. */
  allocatedTotal: number;
  /** declaredTotal - allocatedTotal, or null when there's no declared
   * total to reconcile against. Negative means over-allocated. */
  remaining: number | null;
  /** true only once allocatedTotal exactly equals a recorded declaredTotal
   * (exact integer-hundredths equality, never a tolerance/rounding
   * comparison — see toHundredths). null when there's nothing to
   * reconcile against yet, distinct from false ("reconciled" is not yet a
   * meaningful question until a declared total exists). */
  isComplete: boolean | null;
}

/** The reconciliation the M11-B spec's worked example describes: "Strata
 * Plan Total: 128 / Allocated across Lots: 120 / Remaining: 8" (a
 * warning) vs. "Allocated: 128 / 128 — complete" (success). Never treats
 * the two totals as equally authoritative — declaredTotal is only ever a
 * target to reconcile the real, calculated total against. */
export function reconcileUoe(
  lots: UoeLot[],
  declaredTotal: number | string | null,
): UoeReconciliation {
  const allocatedTotal = calculateTotalUoe(lots);
  if (declaredTotal === null) {
    return { declaredTotal: null, allocatedTotal, remaining: null, isComplete: null };
  }
  const declaredHundredths = toHundredths(declaredTotal);
  const allocatedHundredths = toHundredths(allocatedTotal);
  return {
    declaredTotal: fromHundredths(declaredHundredths),
    allocatedTotal,
    remaining: fromHundredths(declaredHundredths - allocatedHundredths),
    isComplete: declaredHundredths === allocatedHundredths,
  };
}
