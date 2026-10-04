import { describe, expect, it } from 'vitest';
import { classifyNswStrataPlan } from '../../src/modules/property-documents/nsw-strata-plan/classifier.js';
import type { ExtractedPage } from '../../src/modules/property-documents/extraction-provider.interface.js';

function page(text: string, pageNumber = 1): ExtractedPage {
  return { pageNumber, text, confidence: 0.6, method: 'OCR' };
}

describe('classifyNswStrataPlan', () => {
  it('confidently classifies real NSW Strata Plan Form 1 OCR text', () => {
    const result = classifyNswStrataPlan([
      page(
        'STRATA PLAN FORM 1 WARNING: CREASING OR FOLDING WILL LEAD TO REJECTION PLAN OF SUBDIVISION OF LOT 1 DP 1003505 SP64555 L.G.A.: NEWCASTLE Suburb/Locality: MEREWETHER N.S.W. SCHEDULE OF UNIT ENTITLEMENT',
      ),
    ]);
    expect(result.documentType).toBe('NSW_STRATA_PLAN');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.evidence).toContain('Found');
  });

  it('refuses to guess on an unrelated document', () => {
    const result = classifyNswStrataPlan([
      page('INVOICE #4821 Total due: $540.00 Thank you for your business'),
    ]);
    expect(result.documentType).toBeNull();
  });

  it('refuses to guess on a near-empty OCR result', () => {
    const result = classifyNswStrataPlan([page('')]);
    expect(result.documentType).toBeNull();
  });

  it('is less confident about a strata-flavoured document with no NSW marker', () => {
    const withNsw = classifyNswStrataPlan([
      page('STRATA PLAN SP64555 SCHEDULE OF UNIT ENTITLEMENT L.G.A.: NEWCASTLE N.S.W.'),
    ]);
    const withoutNsw = classifyNswStrataPlan([
      page('STRATA PLAN SP64555 SCHEDULE OF UNIT ENTITLEMENT'),
    ]);
    expect(withoutNsw.confidence).toBeLessThan(withNsw.confidence);
  });
});
