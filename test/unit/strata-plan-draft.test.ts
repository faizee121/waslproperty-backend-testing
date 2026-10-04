import { describe, expect, it } from 'vitest';
import {
  applyDraftUpdate,
  seedDraftFromExtraction,
  validateDraft,
} from '../../src/modules/property-documents/nsw-strata-plan/draft.js';
import type {
  ExtractedField,
  StrataPlanExtraction,
} from '../../src/modules/property-documents/nsw-strata-plan/extraction.types.js';

function field<T>(
  value: T | null,
  confidence: 'HIGH' | 'REVIEW' | 'LOW' = 'HIGH',
): ExtractedField<T> {
  return {
    value,
    confidenceScore: confidence === 'HIGH' ? 0.9 : 0.4,
    confidence,
    source: { pageNumber: 1, sourceType: 'OCR' },
  };
}

const sampleExtraction: StrataPlanExtraction = {
  documentType: 'NSW_STRATA_PLAN',
  jurisdiction: { country: 'Australia', state: 'New South Wales' },
  plan: {
    planNumber: field('SP64555'),
    schemeName: field<string>(null, 'LOW'),
    locality: field('Merewether'),
    lga: field('Newcastle'),
    county: field('Northumberland'),
    address: field('87 Frederick Street, Merewether NSW 2291'),
    sourceLot: field('1'),
    sourceDepositedPlan: field('DP 1003505'),
    registrationDate: field('19-12-2000'),
  },
  entitlementSchedule: {
    lots: [
      { lotNumber: field('1'), unitsOfEntitlement: field(144) },
      { lotNumber: field('2'), unitsOfEntitlement: field(136) },
      { lotNumber: field('3'), unitsOfEntitlement: field(154) },
      { lotNumber: field('4'), unitsOfEntitlement: field(154) },
      { lotNumber: field('5'), unitsOfEntitlement: field(245) },
      { lotNumber: field('6'), unitsOfEntitlement: field(103) },
      { lotNumber: field('7'), unitsOfEntitlement: field(64) },
    ],
    declaredTotal: field(1000),
    calculatedTotal: 1000,
    reconciliationStatus: 'RECONCILED',
  },
  physicalStructure: {
    detectedLotParts: ['Lot 2 appears as PT 2 on more than one floor'],
    detectedCommonPropertyReferences: [],
    notes: [],
  },
  issues: [],
  visionAssist: {
    attempted: false,
    triggeredBy: [],
    provider: null,
    model: null,
    pagesUsed: [],
    outcome: 'NOT_TRIGGERED',
    error: null,
  },
};

describe('seedDraftFromExtraction', () => {
  it('never fabricates a property name', () => {
    const draft = seedDraftFromExtraction(sampleExtraction);
    expect(draft.propertyName).toBeNull();
  });

  it('seeds plan/location fields and all 7 lots from the extraction', () => {
    const draft = seedDraftFromExtraction(sampleExtraction);
    expect(draft.strataPlanNumber).toBe('SP64555');
    expect(draft.city).toBe('Merewether');
    expect(draft.state).toBe('NSW');
    expect(draft.country).toBe('Australia');
    expect(draft.addressLine1).toBe('87 Frederick Street, Merewether NSW 2291');
    expect(draft.lots).toHaveLength(7);
    expect(draft.lots.find((l) => l.lotNumber === '5')?.unitsOfEntitlement).toBe(245);
  });

  it('suggests a property code from the plan number', () => {
    const draft = seedDraftFromExtraction(sampleExtraction);
    expect(draft.code).toBe('SP64555');
  });
});

describe('validateDraft', () => {
  it('blocks confirmation until a property name and code are supplied', () => {
    const draft = seedDraftFromExtraction(sampleExtraction);
    const result = validateDraft(draft);
    expect(result.canConfirm).toBe(false);
    expect(result.issues.some((i) => i.code === 'PROPERTY_NAME_REQUIRED')).toBe(true);
  });

  it('allows confirmation once required fields are filled and the schedule reconciles', () => {
    let draft = seedDraftFromExtraction(sampleExtraction);
    draft = applyDraftUpdate(draft, { propertyName: 'Oceanview', code: 'SP64555' });
    const result = validateDraft(draft);
    expect(result.canConfirm).toBe(true);
    expect(result.reconciliationStatus).toBe('RECONCILED');
  });

  it('a correction revalidates immediately without needing re-analysis', () => {
    let draft = seedDraftFromExtraction(sampleExtraction);
    draft = applyDraftUpdate(draft, { propertyName: 'Oceanview', code: 'SP64555' });
    expect(validateDraft(draft).canConfirm).toBe(true);

    const corrupted = applyDraftUpdate(draft, {
      lots: draft.lots.map((l) => (l.lotNumber === '6' ? { ...l, unitsOfEntitlement: 106 } : l)),
    });
    const corruptedResult = validateDraft(corrupted);
    expect(corruptedResult.canConfirm).toBe(false);
    expect(corruptedResult.reconciliationStatus).toBe('MISMATCH');

    const restored = applyDraftUpdate(corrupted, {
      lots: corrupted.lots.map((l) =>
        l.lotNumber === '6' ? { ...l, unitsOfEntitlement: 103 } : l,
      ),
    });
    expect(validateDraft(restored).canConfirm).toBe(true);
  });

  it('preserves every other field when applying a partial update', () => {
    const draft = seedDraftFromExtraction(sampleExtraction);
    const updated = applyDraftUpdate(draft, { propertyName: 'Oceanview' });
    expect(updated.strataPlanNumber).toBe(draft.strataPlanNumber);
    expect(updated.lots).toEqual(draft.lots);
  });
});
