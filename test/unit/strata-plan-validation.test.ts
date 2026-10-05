import { describe, expect, it } from 'vitest';
import {
  hasBlockingIssues,
  validateLotsAndEntitlements,
} from '../../src/modules/property-documents/nsw-strata-plan/validation.js';

// The real supplied NSW-Strata-Plan-Sample.pdf (SP64555, Merewether NSW) —
// inspected directly (rendered + OCR'd) rather than assumed from the
// milestone brief's illustrative numbers, which did not match the actual
// document. Seven lots, declared total 1000, exactly reconciled.
const SAMPLE_LOTS = [
  { lotNumber: '1', unitsOfEntitlement: 144 },
  { lotNumber: '2', unitsOfEntitlement: 136 },
  { lotNumber: '3', unitsOfEntitlement: 154 },
  { lotNumber: '4', unitsOfEntitlement: 154 },
  { lotNumber: '5', unitsOfEntitlement: 245 },
  { lotNumber: '6', unitsOfEntitlement: 103 },
  { lotNumber: '7', unitsOfEntitlement: 64 },
];

describe('validateLotsAndEntitlements', () => {
  it('reconciles the real SP64555 sample schedule exactly (7 lots, total 1000)', () => {
    const result = validateLotsAndEntitlements(SAMPLE_LOTS, 1000);
    expect(result.calculatedTotal).toBe(1000);
    expect(result.reconciliationStatus).toBe('RECONCILED');
    expect(hasBlockingIssues(result.issues)).toBe(false);
    expect(result.shares.get('5')).toBeCloseTo(24.5, 5);
  });

  it('flags a mismatch and computes the exact difference when a lot is edited', () => {
    const edited = SAMPLE_LOTS.map((l) =>
      l.lotNumber === '6' ? { ...l, unitsOfEntitlement: 106 } : l,
    );
    const result = validateLotsAndEntitlements(edited, 1000);
    expect(result.calculatedTotal).toBe(1003);
    expect(result.reconciliationStatus).toBe('MISMATCH');
    expect(hasBlockingIssues(result.issues)).toBe(true);
    expect(result.issues.some((i) => i.code === 'UOE_MISMATCH' && /3/.test(i.message))).toBe(true);
  });

  it('is REVIEW, not blocking, when there is no declared total to reconcile against', () => {
    const result = validateLotsAndEntitlements(SAMPLE_LOTS, null);
    expect(result.reconciliationStatus).toBe('DECLARED_TOTAL_MISSING');
    expect(hasBlockingIssues(result.issues)).toBe(false);
    expect(
      result.issues.some((i) => i.code === 'DECLARED_TOTAL_MISSING' && i.severity === 'REVIEW'),
    ).toBe(true);
  });

  it('blocks on a duplicate lot number', () => {
    const result = validateLotsAndEntitlements(
      [...SAMPLE_LOTS, { lotNumber: '1', unitsOfEntitlement: 10 }],
      1010,
    );
    expect(result.issues.some((i) => i.code === 'DUPLICATE_LOT_NUMBER')).toBe(true);
    expect(hasBlockingIssues(result.issues)).toBe(true);
  });

  it('blocks on a non-positive unit entitlement', () => {
    const result = validateLotsAndEntitlements([{ lotNumber: '1', unitsOfEntitlement: 0 }], 0);
    expect(result.issues.some((i) => i.code === 'NON_POSITIVE_UOE')).toBe(true);
  });

  it('blocks on a missing lot number', () => {
    const result = validateLotsAndEntitlements([{ lotNumber: '  ', unitsOfEntitlement: 100 }], 100);
    expect(result.issues.some((i) => i.code === 'MISSING_LOT_NUMBER')).toBe(true);
  });

  it('blocks when there are no lots at all', () => {
    const result = validateLotsAndEntitlements([], null);
    expect(result.issues.some((i) => i.code === 'NO_LOTS')).toBe(true);
  });

  it('computes deterministic integer-safe shares that sum to 100%', () => {
    const result = validateLotsAndEntitlements(SAMPLE_LOTS, 1000);
    const total = [...result.shares.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 6);
  });
});
