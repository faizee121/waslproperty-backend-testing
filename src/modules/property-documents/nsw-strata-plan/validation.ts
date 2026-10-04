import {
  calculateEntitlementShare,
  calculateTotalUoe,
  reconcileUoe,
} from '../../strata/strata.calculations.js';
import type { ExtractionIssue, ReconciliationStatus } from './extraction.types.js';

/**
 * Deterministic validation — no AI, no randomness, every function here is
 * a pure transform (same principle as strata.calculations.ts, which this
 * module calls into directly rather than re-implementing any UOE math —
 * see M15 Section 14's explicit "reuse existing StrataService semantics,
 * do not create conflicting reconciliation logic"). Called from BOTH the
 * analysis pipeline (producing the frozen extraction snapshot) and the
 * review screen's correction endpoint (recomputing live, never requiring
 * AI re-analysis — Section 21).
 */

export interface DraftLot {
  lotNumber: string;
  unitsOfEntitlement: number;
}

export interface ValidationResult {
  calculatedTotal: number;
  reconciliationStatus: ReconciliationStatus;
  shares: Map<string, number>;
  issues: ExtractionIssue[];
}

export function validateLotsAndEntitlements(
  lots: DraftLot[],
  declaredTotal: number | null,
): ValidationResult {
  const issues: ExtractionIssue[] = [];

  if (lots.length === 0) {
    issues.push({ severity: 'BLOCKING', code: 'NO_LOTS', message: 'No lots were identified.' });
  }

  const seenLotNumbers = new Set<string>();
  for (const lot of lots) {
    const trimmed = lot.lotNumber.trim();
    if (!trimmed) {
      issues.push({
        severity: 'BLOCKING',
        code: 'MISSING_LOT_NUMBER',
        message: 'A lot is missing its lot number.',
      });
      continue;
    }
    if (seenLotNumbers.has(trimmed)) {
      issues.push({
        severity: 'BLOCKING',
        code: 'DUPLICATE_LOT_NUMBER',
        message: `Lot ${trimmed} appears more than once.`,
        field: trimmed,
      });
    }
    seenLotNumbers.add(trimmed);

    if (!Number.isFinite(lot.unitsOfEntitlement)) {
      issues.push({
        severity: 'BLOCKING',
        code: 'INVALID_UOE',
        message: `Lot ${trimmed}'s unit entitlement could not be read as a number.`,
        field: trimmed,
      });
    } else if (lot.unitsOfEntitlement <= 0) {
      issues.push({
        severity: 'BLOCKING',
        code: 'NON_POSITIVE_UOE',
        message: `Lot ${trimmed}'s unit entitlement must be a positive number.`,
        field: trimmed,
      });
    }
  }

  const validLots = lots.filter(
    (l) => Number.isFinite(l.unitsOfEntitlement) && l.unitsOfEntitlement > 0,
  );
  const calculatedTotal = calculateTotalUoe(
    validLots.map((l) => ({ unitsOfEntitlement: l.unitsOfEntitlement })),
  );
  const reconciliation = reconcileUoe(
    validLots.map((l) => ({ unitsOfEntitlement: l.unitsOfEntitlement })),
    declaredTotal,
  );

  let reconciliationStatus: ReconciliationStatus;
  if (declaredTotal === null) {
    reconciliationStatus = 'DECLARED_TOTAL_MISSING';
    issues.push({
      severity: 'REVIEW',
      code: 'DECLARED_TOTAL_MISSING',
      message: 'No declared Units of Entitlement total was found to reconcile against.',
    });
  } else if (
    lots.length === 0 ||
    lots.some((l) => !l.lotNumber.trim() || !Number.isFinite(l.unitsOfEntitlement))
  ) {
    reconciliationStatus = 'INCOMPLETE';
  } else if (reconciliation.isComplete) {
    reconciliationStatus = 'RECONCILED';
  } else {
    reconciliationStatus = 'MISMATCH';
    const diff = reconciliation.remaining ?? 0;
    issues.push({
      severity: 'BLOCKING',
      code: 'UOE_MISMATCH',
      message:
        diff > 0
          ? `The declared total (${declaredTotal}) is ${diff} more than the entitlements currently add up to (${calculatedTotal}).`
          : `The entitlements currently add up to ${Math.abs(diff)} more than the declared total (${declaredTotal}).`,
    });
  }

  const shares = new Map<string, number>();
  for (const lot of validLots) {
    shares.set(
      lot.lotNumber.trim(),
      calculateEntitlementShare(lot.unitsOfEntitlement, calculatedTotal),
    );
  }

  return { calculatedTotal, reconciliationStatus, shares, issues };
}

export function hasBlockingIssues(issues: ExtractionIssue[]): boolean {
  return issues.some((i) => i.severity === 'BLOCKING');
}
