import { SpaceType } from '@prisma/client';
import { z } from 'zod';

/** Step 1+2 of the guided setup ("Strata details" + "Strata plan") — a
 * manager may fill in as much or as little as they have at hand and save
 * progress; every field is optional so entering 100+ lots later isn't
 * blocked on getting this step perfect first (see the M11-B requirement:
 * "do not make entering 100+ lots unnecessarily fragile"). */
export const enableStrataSchema = z.object({
  strataPlanNumber: z.string().trim().max(60).optional(),
  strataSchemeName: z.string().trim().max(160).optional(),
  strataPlanDeclaredUnitsOfEntitlement: z.coerce.number().positive().optional(),
});
export type EnableStrataInput = z.infer<typeof enableStrataSchema>;

/** Updating the Strata Plan's own fields at any point after setup has
 * started — same shape as enableStrataSchema, but every field may also be
 * explicitly cleared (null) once already set, unlike the initial enable
 * call. */
export const updateStrataPlanSchema = z.object({
  strataPlanNumber: z.string().trim().max(60).nullable().optional(),
  strataSchemeName: z.string().trim().max(160).nullable().optional(),
  strataPlanDeclaredUnitsOfEntitlement: z.coerce.number().positive().nullable().optional(),
});
export type UpdateStrataPlanInput = z.infer<typeof updateStrataPlanSchema>;

/** One row of the wizard's "Lots & Units" step / a later bulk edit.
 * `spaceId` present = reuse/update an existing Space as a lot (the M11-B
 * "existing space -> lot mapping" requirement — never creates a duplicate
 * row for an id that's provided). `spaceId` absent = a brand-new lot with
 * no existing Space yet, created via the same Space architecture (name/
 * code/spaceType required, exactly what SpacesService.create needs). UOE
 * must be positive — a strata lot with zero or negative entitlement is
 * never valid (see strata.calculations.ts). */
const existingLotSchema = z.object({
  kind: z.literal('existing'),
  spaceId: z.string().min(1),
  lotNumber: z.string().trim().max(40).optional(),
  unitsOfEntitlement: z.coerce.number().positive(),
});
const newLotSchema = z.object({
  kind: z.literal('new'),
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40),
  spaceType: z.nativeEnum(SpaceType).default('OTHER'),
  lotNumber: z.string().trim().max(40).optional(),
  unitsOfEntitlement: z.coerce.number().positive(),
});

export const bulkSetLotsSchema = z.object({
  lots: z.array(z.discriminatedUnion('kind', [existingLotSchema, newLotSchema])).min(1),
});
export type BulkSetLotsInput = z.infer<typeof bulkSetLotsSchema>;
export type BulkSetLotEntry = BulkSetLotsInput['lots'][number];
export type ExistingLotEntry = z.infer<typeof existingLotSchema>;
export type NewLotEntry = z.infer<typeof newLotSchema>;

/**
 * M11-B.1 — explicitly classifying EXISTING Spaces as a Lot/Unit or
 * Common Property/Area (never inferred from a name, never assumed). A
 * physical Space is never duplicated here — every entry addresses an
 * existing Space by id and updates it in place, exactly like
 * existingLotSchema above. Classifying LOT requires a lot number and a
 * positive UOE in the same action (the M11-B.1 spec's own worked example:
 * "Existing Space -> Choose: Lot/Unit -> Lot Number + UOE, OR Common
 * Property/Area -> no UOE"); classifying COMMON_PROPERTY takes no further
 * fields — SpacesService/StrataService clears any stale lot number/UOE.
 */
const classifyAsLotSchema = z.object({
  spaceId: z.string().min(1),
  classification: z.literal('LOT'),
  lotNumber: z.string().trim().min(1).max(40),
  unitsOfEntitlement: z.coerce.number().positive(),
});
const classifyAsCommonPropertySchema = z.object({
  spaceId: z.string().min(1),
  classification: z.literal('COMMON_PROPERTY'),
});

export const classifySpacesSchema = z.object({
  entries: z
    .array(z.discriminatedUnion('classification', [classifyAsLotSchema, classifyAsCommonPropertySchema]))
    .min(1),
});
export type ClassifySpacesInput = z.infer<typeof classifySpacesSchema>;
export type ClassifySpaceEntry = ClassifySpacesInput['entries'][number];
