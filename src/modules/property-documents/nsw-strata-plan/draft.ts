import { z } from 'zod';
import type { ExtractionIssue, StrataPlanExtraction } from './extraction.types.js';
import { validateLotsAndEntitlements } from './validation.js';

/**
 * The CURRENT, user-editable review state — seeded from a
 * StrataPlanExtraction once analysis succeeds, then mutated in place by
 * the review screen (never triggers re-analysis; see Section 21). This is
 * what PropertyDocument.draft stores. Deliberately flat/plain values
 * (never ExtractedField wrappers) — provenance for "what did the document
 * originally say" always comes from the separate, frozen
 * DocumentAnalysis.extraction, looked up by field key when needed (e.g.
 * "View source"), never duplicated here.
 */
export interface StrataPlanDraft {
  propertyName: string | null;
  code: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  propertyType: 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED_USE';
  strataPlanNumber: string | null;
  strataSchemeName: string | null;
  strataPlanDeclaredUnitsOfEntitlement: number | null;
  lots: Array<{ lotNumber: string; unitsOfEntitlement: number }>;
}

export const updateDraftSchema = z.object({
  propertyName: z.string().trim().min(1).max(160).nullable().optional(),
  code: z.string().trim().min(1).max(40).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  propertyType: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE']).optional(),
  strataSchemeName: z.string().trim().max(160).nullable().optional(),
  strataPlanDeclaredUnitsOfEntitlement: z.coerce.number().positive().nullable().optional(),
  lots: z
    .array(
      z.object({
        lotNumber: z.string().trim().min(1).max(20),
        unitsOfEntitlement: z.coerce.number(),
      }),
    )
    .optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

function suggestCode(planNumber: string | null): string | null {
  return planNumber ? planNumber.toUpperCase().replace(/\s+/g, '') : null;
}

/** Builds the initial draft from a freshly-completed extraction — every
 * field a plain best-effort suggestion the user can edit, never presented
 * as authoritative (the frontend review screen is what makes that
 * distinction visible). */
export function seedDraftFromExtraction(extraction: StrataPlanExtraction): StrataPlanDraft {
  return {
    propertyName: null, // never fabricated — see Section 20, this is always a required manual field
    code: suggestCode(extraction.plan.planNumber.value),
    addressLine1: extraction.plan.address.value,
    addressLine2: null,
    city: extraction.plan.locality.value,
    state: 'NSW',
    postalCode: null,
    country: 'Australia',
    propertyType: 'RESIDENTIAL',
    strataPlanNumber: extraction.plan.planNumber.value,
    strataSchemeName: extraction.plan.schemeName.value,
    strataPlanDeclaredUnitsOfEntitlement: extraction.entitlementSchedule.declaredTotal.value,
    lots: extraction.entitlementSchedule.lots
      .filter((l) => l.lotNumber.value !== null && l.unitsOfEntitlement.value !== null)
      .map((l) => ({
        lotNumber: l.lotNumber.value as string,
        unitsOfEntitlement: l.unitsOfEntitlement.value as number,
      })),
  };
}

export function applyDraftUpdate(
  current: StrataPlanDraft,
  input: UpdateDraftInput,
): StrataPlanDraft {
  return {
    ...current,
    ...(input.propertyName !== undefined && { propertyName: input.propertyName }),
    ...(input.code !== undefined && { code: input.code }),
    ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
    ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.state !== undefined && { state: input.state }),
    ...(input.postalCode !== undefined && { postalCode: input.postalCode }),
    ...(input.propertyType !== undefined && { propertyType: input.propertyType }),
    ...(input.strataSchemeName !== undefined && { strataSchemeName: input.strataSchemeName }),
    ...(input.strataPlanDeclaredUnitsOfEntitlement !== undefined && {
      strataPlanDeclaredUnitsOfEntitlement: input.strataPlanDeclaredUnitsOfEntitlement,
    }),
    ...(input.lots !== undefined && { lots: input.lots }),
  };
}

export interface DraftValidationResult {
  issues: ExtractionIssue[];
  calculatedTotal: number;
  reconciliationStatus: ReturnType<typeof validateLotsAndEntitlements>['reconciliationStatus'];
  shares: Record<string, number>;
  canConfirm: boolean;
}

/** Live revalidation of the current draft — called on every GET and every
 * PATCH, never requires AI. Combines the UOE/lot checks (validation.ts)
 * with the property-level "required for creation" checks the document
 * alone can never satisfy (a name, most of all). */
export function validateDraft(draft: StrataPlanDraft): DraftValidationResult {
  const uoe = validateLotsAndEntitlements(draft.lots, draft.strataPlanDeclaredUnitsOfEntitlement);
  const issues = [...uoe.issues];

  if (!draft.propertyName?.trim()) {
    issues.push({
      severity: 'BLOCKING',
      code: 'PROPERTY_NAME_REQUIRED',
      message: 'Enter a property name.',
    });
  }
  if (!draft.code?.trim()) {
    issues.push({
      severity: 'BLOCKING',
      code: 'PROPERTY_CODE_REQUIRED',
      message: 'Enter a property code.',
    });
  }
  if (!draft.addressLine1?.trim()) {
    issues.push({
      severity: 'REVIEW',
      code: 'ADDRESS_REQUIRED',
      message: 'Enter the property address.',
    });
  }
  if (!draft.city?.trim()) {
    issues.push({ severity: 'REVIEW', code: 'CITY_REQUIRED', message: 'Enter the suburb/city.' });
  }

  const shares: Record<string, number> = {};
  for (const [lotNumber, share] of uoe.shares) shares[lotNumber] = share;

  return {
    issues,
    calculatedTotal: uoe.calculatedTotal,
    reconciliationStatus: uoe.reconciliationStatus,
    shares,
    canConfirm: !issues.some((i) => i.severity === 'BLOCKING'),
  };
}
