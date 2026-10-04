import type { ExtractedPage } from '../extraction-provider.interface.js';

export interface ClassificationResult {
  documentType: 'NSW_STRATA_PLAN' | null;
  confidence: number;
  evidence: string;
}

/**
 * Evidence-based classification — never "if filename contains 'strata'"
 * (M15 Section 6's explicit prohibition). Looks for the small set of
 * phrases that reliably, uniquely appear on a real NSW Strata Plan Form 1
 * (the registration cover sheet every one of these documents has) and
 * scores confidence from how many independent markers actually matched,
 * never a single invented number. A document with none of these markers
 * is classified as unsupported rather than guessed at.
 */
const STRATA_PLAN_MARKERS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /STRATA\s+PLAN/i, weight: 0.3 },
  { pattern: /SCHEDULE\s+OF\s+UNIT\s+ENTITLEMENT/i, weight: 0.3 },
  { pattern: /\bSP\s?\d{3,6}\b/i, weight: 0.2 },
  { pattern: /L\.?G\.?A\.?\s*:/i, weight: 0.1 },
  { pattern: /STRATA\s+SCHEMES?\s*\(?(FREEHOLD|LEASEHOLD)/i, weight: 0.2 },
  { pattern: /SUBDIVISION\s+OF\s+LOT/i, weight: 0.1 },
];

const NEW_SOUTH_WALES_MARKER = /N\.?S\.?W\.?|NEW\s+SOUTH\s+WALES/i;

export function classifyNswStrataPlan(pages: ExtractedPage[]): ClassificationResult {
  const combinedText = pages.map((p) => p.text).join('\n');

  const matched = STRATA_PLAN_MARKERS.filter((m) => m.pattern.test(combinedText));
  let score = matched.reduce((sum, m) => sum + m.weight, 0);

  const hasNsw = NEW_SOUTH_WALES_MARKER.test(combinedText);
  if (!hasNsw) score *= 0.6; // still plausibly a strata plan, but not confidently NSW

  score = Math.min(1, score);

  const evidence =
    matched.length > 0
      ? `Found: ${matched.map((m) => m.pattern.source).join(', ')}${hasNsw ? '; NSW jurisdiction marker present' : '; no explicit NSW marker found'}`
      : 'No recognised NSW Strata Plan markers found in the extracted text.';

  // Below this bar we refuse to guess — see Section 6: "DO NOT guess."
  const CONFIDENT_THRESHOLD = 0.5;

  return {
    documentType: score >= CONFIDENT_THRESHOLD ? 'NSW_STRATA_PLAN' : null,
    confidence: score,
    evidence,
  };
}
