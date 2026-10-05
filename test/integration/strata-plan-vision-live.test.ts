import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';

// test/setup.ts loads .env.test FIRST (before any test file runs), which
// sets a FAKE DEEPSEEK_API_KEY placeholder so every mocked test never
// accidentally needs a real one — and dotenv never overrides an
// already-set process.env value, so the real key in the real .env never
// reaches process.env on its own here. This test genuinely needs the
// real key (it makes real network calls), so it reads the real .env file
// directly and overrides the placeholder explicitly, rather than relying
// on dotenv's normal precedence.
const REAL_ENV_PATH = path.resolve(import.meta.dirname, '../../.env');
const realEnv = existsSync(REAL_ENV_PATH) ? parseDotenv(readFileSync(REAL_ENV_PATH)) : {};
const realDeepseekKey = realEnv.DEEPSEEK_API_KEY;

/**
 * A deliberately REAL, non-mocked evaluation test — exercises the actual
 * extraction -> classification -> AI interpretation -> vision-fallback
 * pipeline against the actual supplied NSW-Strata-Plan-Sample.pdf, not a
 * synthetic fixture (see the M15.1 vision-fallback spec's explicit "Test
 * against the ACTUAL uploaded sample PDF" requirement). Every other test
 * in this suite mocks providers for speed/determinism — this one exists
 * specifically so the ground-truth numbers below are checked against
 * genuine model output, not a mock that could drift from reality.
 *
 * The ground-truth values are ONLY used as test assertions here — see
 * the spec's explicit instruction not to hard-code or special-case them
 * anywhere in production code, prompts, or fixtures that feed the
 * extraction algorithm itself.
 *
 * Requires DEEPSEEK_API_KEY (text + vision), DOCUMENT_ANALYSIS_VISION_ENABLED
 * is force-enabled below regardless of .env, and the sample PDF at the
 * path below. Skips gracefully (not a failure) when either precondition
 * isn't met, since this is an evaluation test tied to a real local file
 * and a real paid API call, not something every environment/CI can run.
 */
const SAMPLE_PDF_PATH = '/Users/hamza.tariq/Downloads/NSW-Strata-Plan-Sample.pdf';
const hasKey = Boolean(realDeepseekKey);
const hasSample = existsSync(SAMPLE_PDF_PATH);

describe.skipIf(!hasKey || !hasSample)(
  'Vision fallback — live evaluation against the real sample PDF',
  () => {
    it('independently recovers all 7 lots and reconciles to 1000 via the vision fallback, from the real degraded scan', async () => {
      process.env.DEEPSEEK_API_KEY = realDeepseekKey;
      process.env.DOCUMENT_ANALYSIS_VISION_ENABLED = 'true';
      process.env.AI_ENABLED = 'true';

      const { PdfOcrExtractionProvider } =
        await import('../../src/modules/property-documents/providers/pdf-ocr-extraction.provider.js');
      const { classifyNswStrataPlan } =
        await import('../../src/modules/property-documents/nsw-strata-plan/classifier.js');
      const { interpretStrataPlan } =
        await import('../../src/modules/property-documents/nsw-strata-plan/interpreter.js');
      const { assembleStrataPlanExtraction } =
        await import('../../src/modules/property-documents/nsw-strata-plan/assemble.js');
      const { runVisionFallbackIfNeeded } =
        await import('../../src/modules/property-documents/nsw-strata-plan/vision-fallback.js');

      const bytes = readFileSync(SAMPLE_PDF_PATH);

      const provider = new PdfOcrExtractionProvider();
      const extraction = await provider.extract(bytes, 30);

      const classification = classifyNswStrataPlan(extraction.pages);
      expect(classification.documentType).toBe('NSW_STRATA_PLAN');

      const rawInterpretation = await interpretStrataPlan(extraction.pages);
      const ocrOnlyExtraction = assembleStrataPlanExtraction(rawInterpretation, extraction.pages);

      // Ground truth, for this console output and the assertions below
      // only — never consulted by any production code path.
      console.log(
        'OCR-only lots before vision:',
        ocrOnlyExtraction.entitlementSchedule.lots.length,
        'reconciliation:',
        ocrOnlyExtraction.entitlementSchedule.reconciliationStatus,
      );

      const { extraction: finalExtraction, visionAssist } = await runVisionFallbackIfNeeded({
        pdfBytes: bytes,
        extraction: ocrOnlyExtraction,
        ocrRotationDeg: extraction.ocrRotationDeg,
      });

      console.log('visionAssist:', JSON.stringify(visionAssist, null, 2));
      console.log(
        'Final lots:',
        finalExtraction.entitlementSchedule.lots
          .map(
            (l) =>
              `${l.lotNumber.value}=${l.unitsOfEntitlement.value} (${l.unitsOfEntitlement.confidence}/${l.unitsOfEntitlement.source.sourceType})`,
          )
          .sort(),
      );
      console.log(
        'calculatedTotal:',
        finalExtraction.entitlementSchedule.calculatedTotal,
        'reconciliationStatus:',
        finalExtraction.entitlementSchedule.reconciliationStatus,
      );

      expect(visionAssist.attempted).toBe(true);
      expect(visionAssist.outcome).toBe('SUCCEEDED');

      const byLotNumber = new Map(
        finalExtraction.entitlementSchedule.lots.map((l) => [
          l.lotNumber.value,
          l.unitsOfEntitlement.value,
        ]),
      );
      expect(byLotNumber.get('1')).toBe(144);
      expect(byLotNumber.get('2')).toBe(136);
      expect(byLotNumber.get('3')).toBe(154);
      expect(byLotNumber.get('4')).toBe(154);
      expect(byLotNumber.get('5')).toBe(245);
      expect(byLotNumber.get('6')).toBe(103);
      expect(byLotNumber.get('7')).toBe(64);

      expect(finalExtraction.entitlementSchedule.calculatedTotal).toBe(1000);
      expect(finalExtraction.entitlementSchedule.reconciliationStatus).toBe('RECONCILED');
    }, 120000);
  },
);
