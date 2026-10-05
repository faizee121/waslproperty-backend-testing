import { z } from 'zod';
import { env } from '../../config/env.js';

export const presignPropertyDocumentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.literal('application/pdf'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(env.DOCUMENT_ANALYSIS_MAX_FILE_SIZE_MB * 1024 * 1024),
});
export type PresignPropertyDocumentInput = z.infer<typeof presignPropertyDocumentSchema>;

export const registerPropertyDocumentSchema = z.object({
  storageKey: z.string().trim().min(1),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.literal('application/pdf'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(env.DOCUMENT_ANALYSIS_MAX_FILE_SIZE_MB * 1024 * 1024),
});
export type RegisterPropertyDocumentInput = z.infer<typeof registerPropertyDocumentSchema>;

export { updateDraftSchema, type UpdateDraftInput } from './nsw-strata-plan/draft.js';
