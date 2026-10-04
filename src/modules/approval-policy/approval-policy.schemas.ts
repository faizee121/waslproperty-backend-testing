import { z } from 'zod';
import { currencyCodeSchema } from '../../lib/currencies.js';

const workflowModeSchema = z.enum([
  'NONE',
  'APPROVAL_ONLY',
  'SIGNATURE_ONLY',
  'APPROVAL_THEN_SIGNATURE',
]);

/** Two-decimal-place money — rejects 12.999 etc. so no rule boundary is
 * ever ambiguous about which cent it belongs to. */
const moneyAmountSchema = z.coerce
  .number()
  .positive('Enter an amount greater than zero')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
    message: 'Amounts can have at most 2 decimal places',
  });

/** One band, as the client sends it — deliberately no minAmount: the
 * server derives every band's lower bound from the previous band's upper
 * bound (see ApprovalPolicyService.upsertPolicy), which is what makes
 * overlapping/gapped ranges structurally impossible rather than something
 * validated after the fact. Only the highest band may have maxAmount null
 * (open-ended, "and above") — enforced by the object-level refinement
 * below, not here, since it depends on array position. */
const policyRuleInputSchema = z.object({
  maxAmount: moneyAmountSchema.nullable(),
  workflowMode: workflowModeSchema,
});

export const upsertApprovalPolicySchema = z.object({
  currencyCode: currencyCodeSchema,
  enabled: z.boolean().default(true),
  rules: z
    .array(policyRuleInputSchema)
    .min(1, 'Add at least one rule')
    .max(20, 'Too many rules')
    .refine((rules) => rules.slice(0, -1).every((r) => r.maxAmount !== null), {
      message: 'Only the highest band may be open-ended',
      path: ['rules'],
    })
    .refine((rules) => rules[rules.length - 1]?.maxAmount === null, {
      message: 'The highest band must be open-ended ("and above") — set its amount to blank',
      path: ['rules'],
    })
    .refine(
      (rules) => {
        const caps = rules.slice(0, -1).map((r) => Math.round((r.maxAmount as number) * 100));
        return caps.every((c, i) => i === 0 || c > (caps[i - 1] as number));
      },
      { message: 'Each band must be higher than the one before it', path: ['rules'] },
    ),
});
export type UpsertApprovalPolicyInput = z.infer<typeof upsertApprovalPolicySchema>;

export const resolveApprovalPolicySchema = z.object({
  amount: z.coerce.number().nonnegative(),
  currencyCode: currencyCodeSchema,
});
export type ResolveApprovalPolicyInput = z.infer<typeof resolveApprovalPolicySchema>;
