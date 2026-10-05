import { z } from 'zod';

const resourceContextSchema = z.object({
  resourceType: z.enum([
    'MAINTENANCE_REQUEST',
    'WORK_ORDER',
    'CONTRACTOR_QUOTE',
    'QUOTE_ROUND',
    'CONTRACTOR',
    'PROPERTY',
    'WORK_ORDER_VARIATION',
    'COMMUNICATION',
  ]),
  resourceId: z.string().min(1),
});

const responseIntentSchema = z.enum(['SUMMARY', 'STANDARD', 'DETAILED']).optional();

export const startConversationSchema = z.object({
  message: z.string().min(1).max(4000),
  context: resourceContextSchema.optional(),
  responseIntent: responseIntentSchema,
});
export type StartConversationInput = z.infer<typeof startConversationSchema>;

export const continueConversationSchema = z.object({
  message: z.string().min(1).max(4000),
  responseIntent: responseIntentSchema,
});
export type ContinueConversationInput = z.infer<typeof continueConversationSchema>;
