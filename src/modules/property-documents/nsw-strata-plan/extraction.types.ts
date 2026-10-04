import { z } from 'zod';

/**
 * HIGH / REVIEW / LOW — the only confidence vocabulary ever shown to a
 * user (see confidence.ts for how a raw 0-1 score maps to this). Never a
 * raw decimal in the UI — that is "decorative fake precision" the M15
 * spec explicitly warns against.
 */
export const confidenceLevelSchema = z.enum(['HIGH', 'REVIEW', 'LOW']);
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;

export const extractionSourceTypeSchema = z.enum([
  'PDF_TEXT',
  'OCR',
  'VISION',
  'AI_INTERPRETATION',
  'DERIVED',
]);
export type ExtractionSourceType = z.infer<typeof extractionSourceTypeSchema>;

/** One extracted business field, generically — every field the AI
 * interpretation stage returns is wrapped in this shape, never a bare
 * value. `value: null` with `confidence: LOW` is how "the document did
 * not reliably provide this" is represented — never a guessed string.
 * (The wrapping itself happens in assemble.ts's `wrap()`, which also
 * derives confidence — this type just names the resulting shape; the
 * zod `extractionSourceSchema` above documents what source look like but
 * ExtractedField<T> values are built directly, not parsed from AI output,
 * since confidence is deterministic, not model-supplied.) */
export type ExtractedField<T> = {
  value: T | null;
  confidenceScore: number;
  confidence: ConfidenceLevel;
  source: { pageNumber: number | null; sourceType: ExtractionSourceType; evidence?: string | null };
};

export const reconciliationStatusSchema = z.enum([
  'RECONCILED',
  'MISMATCH',
  'DECLARED_TOTAL_MISSING',
  'INCOMPLETE',
]);
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;

/**
 * Raw output of the AI interpretation stage, before any ExtractedField
 * wrapping — the model only ever has to produce VALUES and, per field,
 * which page it saw them on. Confidence is never asked of the model (see
 * confidence.ts's own doc comment on why) — it is derived deterministically
 * afterward from OCR + validation signals and merged in by the
 * interpreter, producing the fully wrapped StrataPlanExtraction below.
 */
export const rawStrataPlanInterpretationSchema = z.object({
  planNumber: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  schemeName: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  locality: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  lga: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  county: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  address: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  sourceLot: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  sourceDepositedPlan: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  registrationDate: z.object({
    value: z.string().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  declaredTotal: z.object({
    value: z.number().nullable(),
    pageNumber: z.number().int().positive().nullable(),
  }),
  lots: z.array(
    z.object({
      lotNumber: z.string(),
      unitsOfEntitlement: z.number(),
      pageNumber: z.number().int().positive().nullable(),
    }),
  ),
  /** Free-text notes about physical lot parts (PT labels) the model
   * noticed on plan drawing pages — informational only, never turned into
   * Lots (see Section 15). */
  physicalStructureNotes: z.array(z.string()).max(20),
  /** Free-text notes about plan-labelled common-property markers — never
   * auto-created as Spaces (see Section 16). */
  commonPropertyNotes: z.array(z.string()).max(20),
});
export type RawStrataPlanInterpretation = z.infer<typeof rawStrataPlanInterpretationSchema>;

/** The final, fully provenance-wrapped structured extraction — exactly
 * the shape described in M15 Section 9, persisted verbatim (frozen) onto
 * DocumentAnalysis.extraction. */
export interface StrataPlanExtraction {
  documentType: 'NSW_STRATA_PLAN';
  jurisdiction: { country: 'Australia'; state: 'New South Wales' };
  plan: {
    planNumber: ExtractedField<string>;
    schemeName: ExtractedField<string>;
    locality: ExtractedField<string>;
    lga: ExtractedField<string>;
    county: ExtractedField<string>;
    address: ExtractedField<string>;
    sourceLot: ExtractedField<string>;
    sourceDepositedPlan: ExtractedField<string>;
    registrationDate: ExtractedField<string>;
  };
  entitlementSchedule: {
    lots: Array<{ lotNumber: ExtractedField<string>; unitsOfEntitlement: ExtractedField<number> }>;
    declaredTotal: ExtractedField<number>;
    calculatedTotal: number;
    reconciliationStatus: ReconciliationStatus;
  };
  physicalStructure: {
    detectedLotParts: string[];
    detectedCommonPropertyReferences: string[];
    notes: string[];
  };
  issues: ExtractionIssue[];
  visionAssist: VisionAssistMeta;
}

/** Audit/transparency record of whether the bounded vision fallback ran
 * for this analysis — see nsw-strata-plan/vision-fallback.ts. Never
 * affects how a field's own confidence/UI provenance is shown (that is
 * entirely carried by each ExtractedField.source.sourceType/confidence);
 * this is purely "what happened and why", for debugging and for the
 * document-level context (e.g. surfaced on DocumentContextBar). */
export interface VisionAssistMeta {
  attempted: boolean;
  /** Which critical-field gaps triggered the attempt, e.g.
   * ["NO_LOTS_EXTRACTED", "RECONCILIATION_INCOMPLETE"]. Empty when
   * nothing triggered it. */
  triggeredBy: string[];
  provider: string | null;
  model: string | null;
  pagesUsed: number[];
  outcome: 'DISABLED' | 'NOT_TRIGGERED' | 'SUCCEEDED' | 'FAILED';
  error: string | null;
}

export type IssueSeverity = 'INFO' | 'REVIEW' | 'BLOCKING';

export interface ExtractionIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  field?: string;
}
