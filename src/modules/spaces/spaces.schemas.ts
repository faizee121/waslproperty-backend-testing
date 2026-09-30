import { SpaceStatus, SpaceStrataClassification, SpaceType } from '@prisma/client';
import { z } from 'zod';

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40),
  spaceType: z.nativeEnum(SpaceType),
  floor: z.string().trim().max(40).optional(),
  sizeSqft: z.coerce.number().int().positive().optional(),
  /** Foundational strata lot metadata (M11-A) — only settable when the
   * owning property is itself isStrataManaged, which in turn requires the
   * organisation to have STRATA_MANAGEMENT (both enforced in
   * SpacesService). Legacy — kept working exactly as before for backward
   * compatibility; prefer strataClassification for new callers (M11-B.1).
   * See resolveSpaceClassification for how the two reconcile. */
  isStrataLot: z.boolean().optional(),
  lotNumber: z.string().trim().max(40).optional(),
  entitlementValue: z.coerce.number().positive().optional(),
  /** LOT / COMMON_PROPERTY (M11-B.1) — explicit strata classification,
   * required for a new Space on an ACTIVE strata property (enforced in
   * SpacesService, never just hidden in the UI). UNCLASSIFIED is
   * deliberately not offered here: a caller either states a real
   * classification or omits the field entirely (leaving it UNCLASSIFIED
   * by the schema default), matching "never inferred, always explicit". */
  strataClassification: z.enum(['LOT', 'COMMON_PROPERTY']).optional(),
});
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type { SpaceStrataClassification };

export const updateSpaceSchema = createSpaceSchema.partial().extend({
  status: z.nativeEnum(SpaceStatus).optional(),
});
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;
