import type { ConfidenceLevel } from './extraction.types.js';

/**
 * Confidence is derived, never invented. The AI interpretation stage is
 * never asked "how confident are you" (a model stating "0.97" is not a
 * calibrated probability — M15 Section 11's explicit warning); instead
 * every field's confidence is computed here from real, measurable
 * signals: the OCR engine's own mean confidence for the page the value
 * came from, whether the field is present at all, and — for fields a
 * deterministic cross-check can corroborate (the UOE schedule against its
 * declared total) — a transparent boost/penalty.
 */
export interface ConfidenceInputs {
  /** 0-1, the OCR engine's mean confidence for the source page. Null for
   * a DERIVED field with no single page of its own. */
  ocrPageConfidence: number | null;
  /** The extracted value itself — null/empty counts as LOW regardless of
   * OCR confidence (an OCR engine can be "confident" about nothing being
   * there, which still isn't a usable field). */
  present: boolean;
  /** A field a deterministic check has corroborated (e.g. the lot
   * schedule reconciles exactly against the declared total) gets a
   * bounded boost — never enough to turn a genuinely unreadable field
   * HIGH on its own. */
  crossCheckBoost?: number;
}

const HIGH_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.5;

export function deriveFieldConfidence(input: ConfidenceInputs): {
  confidenceScore: number;
  confidence: ConfidenceLevel;
} {
  if (!input.present) {
    return { confidenceScore: 0, confidence: 'LOW' };
  }

  const base = input.ocrPageConfidence ?? 0.6; // a DERIVED field with no OCR signal starts neutral
  const boosted = Math.min(1, base + (input.crossCheckBoost ?? 0));

  const confidence: ConfidenceLevel =
    boosted >= HIGH_THRESHOLD ? 'HIGH' : boosted >= REVIEW_THRESHOLD ? 'REVIEW' : 'LOW';

  return { confidenceScore: Math.round(boosted * 100) / 100, confidence };
}

/** The classification confidence itself, mapped to the same HIGH/REVIEW/
 * LOW vocabulary shown everywhere else — kept separate from field-level
 * confidence since it describes the whole document, not one value. */
export function classificationConfidenceLevel(score: number): ConfidenceLevel {
  return score >= HIGH_THRESHOLD ? 'HIGH' : score >= REVIEW_THRESHOLD ? 'REVIEW' : 'LOW';
}
