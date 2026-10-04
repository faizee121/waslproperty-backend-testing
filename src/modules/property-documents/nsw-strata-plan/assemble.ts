import type { ExtractedPage } from '../extraction-provider.interface.js';
import { deriveFieldConfidence } from './confidence.js';
import type {
  ExtractedField,
  ExtractionIssue,
  RawStrataPlanInterpretation,
  StrataPlanExtraction,
} from './extraction.types.js';
import { validateLotsAndEntitlements } from './validation.js';

function pageConfidence(pages: ExtractedPage[], pageNumber: number | null): number | null {
  if (pageNumber === null) return null;
  const page = pages.find((p) => p.pageNumber === pageNumber);
  return page ? page.confidence : null;
}

function wrap<T>(
  value: T | null,
  pageNumber: number | null,
  pages: ExtractedPage[],
  evidence: string,
  crossCheckBoost?: number,
): ExtractedField<T> {
  const { confidenceScore, confidence } = deriveFieldConfidence({
    ocrPageConfidence: pageConfidence(pages, pageNumber),
    present: value !== null && value !== undefined && value !== '',
    crossCheckBoost,
  });
  return {
    value: value === undefined ? null : value,
    confidenceScore,
    confidence,
    source: { pageNumber, sourceType: pageNumber !== null ? 'OCR' : 'AI_INTERPRETATION', evidence },
  };
}

/**
 * Combines the raw AI interpretation + the OCR pages it came from into the
 * final, fully provenance-wrapped StrataPlanExtraction, and runs
 * deterministic validation over the lot schedule — the one place
 * extraction and validation meet before a DocumentAnalysis row is
 * persisted. Never mutates its inputs; always a pure transform.
 */
export function assembleStrataPlanExtraction(
  raw: RawStrataPlanInterpretation,
  pages: ExtractedPage[],
): StrataPlanExtraction {
  const validation = validateLotsAndEntitlements(
    raw.lots.map((l) => ({ lotNumber: l.lotNumber, unitsOfEntitlement: l.unitsOfEntitlement })),
    raw.declaredTotal.value,
  );

  // A reconciled schedule is real, deterministic corroboration — every
  // lot's UOE field (and the declared total itself) earns a bounded
  // confidence boost because an independent arithmetic check agrees with
  // what OCR read, not because the model "sounded sure".
  const crossCheckBoost = validation.reconciliationStatus === 'RECONCILED' ? 0.15 : 0;

  const issues: ExtractionIssue[] = [...validation.issues];
  for (const note of raw.physicalStructureNotes) {
    issues.push({ severity: 'INFO', code: 'LOT_PART_DETECTED', message: note });
  }
  for (const note of raw.commonPropertyNotes) {
    issues.push({ severity: 'INFO', code: 'COMMON_PROPERTY_DETECTED', message: note });
  }
  if (!raw.address.value) {
    issues.push({
      severity: 'REVIEW',
      code: 'ADDRESS_NOT_FOUND',
      message: 'A property address could not be confidently identified — please enter it.',
    });
  }

  return {
    documentType: 'NSW_STRATA_PLAN',
    jurisdiction: { country: 'Australia', state: 'New South Wales' },
    plan: {
      planNumber: wrap(
        raw.planNumber.value,
        raw.planNumber.pageNumber,
        pages,
        'Strata plan registration',
      ),
      schemeName: wrap(raw.schemeName.value, raw.schemeName.pageNumber, pages, 'Scheme name'),
      locality: wrap(raw.locality.value, raw.locality.pageNumber, pages, 'Suburb/Locality'),
      lga: wrap(raw.lga.value, raw.lga.pageNumber, pages, 'L.G.A.'),
      county: wrap(raw.county.value, raw.county.pageNumber, pages, 'County'),
      address: wrap(
        raw.address.value,
        raw.address.pageNumber,
        pages,
        'Address for service of notices',
      ),
      sourceLot: wrap(raw.sourceLot.value, raw.sourceLot.pageNumber, pages, 'Plan of subdivision'),
      sourceDepositedPlan: wrap(
        raw.sourceDepositedPlan.value,
        raw.sourceDepositedPlan.pageNumber,
        pages,
        'Plan of subdivision',
      ),
      registrationDate: wrap(
        raw.registrationDate.value,
        raw.registrationDate.pageNumber,
        pages,
        'Registered date',
      ),
    },
    entitlementSchedule: {
      lots: raw.lots.map((l) => ({
        lotNumber: wrap(
          l.lotNumber,
          l.pageNumber,
          pages,
          'Schedule of Unit Entitlement',
          crossCheckBoost,
        ),
        unitsOfEntitlement: wrap(
          l.unitsOfEntitlement,
          l.pageNumber,
          pages,
          'Schedule of Unit Entitlement',
          crossCheckBoost,
        ),
      })),
      declaredTotal: wrap(
        raw.declaredTotal.value,
        raw.declaredTotal.pageNumber,
        pages,
        'Schedule of Unit Entitlement total',
        crossCheckBoost,
      ),
      calculatedTotal: validation.calculatedTotal,
      reconciliationStatus: validation.reconciliationStatus,
    },
    physicalStructure: {
      detectedLotParts: raw.physicalStructureNotes,
      detectedCommonPropertyReferences: raw.commonPropertyNotes,
      notes: [],
    },
    issues,
    // Set by the caller (analysis-runner.ts) after this OCR-only pass is
    // assembled — see nsw-strata-plan/vision-fallback.ts. Defaults to
    // "nothing happened yet" so this function stays a pure, vision-unaware
    // transform (Section 6's separation of concerns).
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
}
