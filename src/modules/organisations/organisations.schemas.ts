import { z } from 'zod';
import { countryCodeSchema } from '../../lib/countries.js';
import { currencyCodeSchema } from '../../lib/currencies.js';

export const updateOrganisationSchema = z
  .object({
    currencyCode: currencyCodeSchema.optional(),
    countryCode: countryCodeSchema.optional(),
    /// The org-level Wasl AI kill switch (M14) — see
    /// Organisation.aiEnabled's own doc comment. One of three ANDed
    /// conditions for AI to be usable at all; OWNER/ADMIN only, same as
    /// every other field here.
    aiEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.currencyCode !== undefined ||
      value.countryCode !== undefined ||
      value.aiEnabled !== undefined,
    { message: 'Provide at least one field to update' },
  );
export type UpdateOrganisationInput = z.infer<typeof updateOrganisationSchema>;
