import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { registry } from '../registry.js';

/**
 * The exact shape every error response in the API uses — see
 * src/middlewares/errorHandler.ts and src/errors/AppError.ts. `code` is a
 * stable machine-readable string (NOT_FOUND, VALIDATION_ERROR,
 * UNAUTHORIZED, FORBIDDEN, CONFLICT, AI_RATE_LIMITED, INTERNAL_ERROR, or a
 * handful of narrower AppError codes raised by individual services);
 * `details` is only ever present on a subset of errors (notably Zod
 * validation failures, where it is `ZodError.flatten()`'s shape) and is
 * omitted otherwise.
 */
export const apiErrorSchema = registry.register(
  'ApiError',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'Validation failed' }),
      details: z.unknown().optional(),
    }),
  }),
);

export function jsonContent(schema: ZodTypeAny, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: apiErrorSchema } },
  };
}

/** Standard 401/403/404 trio most authenticated routes can return, plus a
 * 422 for routes that accept a request body/query. Call with the subset
 * that is actually reachable for a given route — do not claim a status an
 * endpoint cannot produce. */
export const commonErrors = {
  400: errorResponse('The request was malformed.'),
  401: errorResponse('Missing, invalid, or expired access token.'),
  403: errorResponse('Authenticated, but missing the required capability or role.'),
  404: errorResponse(
    'The resource does not exist, or exists in a different organisation than the caller’s ' +
      '— both are reported identically so a cross-organisation id can never be distinguished ' +
      'from one that genuinely does not exist.',
  ),
  409: errorResponse('The request conflicts with the resource’s current state.'),
  422: errorResponse('Request body/query failed schema validation (Zod).'),
  429: errorResponse('Too many requests — currently only returned by Wasl AI endpoints.'),
};

/** The one pagination envelope used by every list endpoint in the API —
 * see src/lib/pagination.ts's PaginatedResult<T>. Always `items` + `page` +
 * `pageSize` + `total`; no endpoint uses a cursor today. */
export function paginatedSchema<T extends ZodTypeAny>(itemSchema: T, itemName: string) {
  return registry.register(
    `Paginated${itemName}`,
    z.object({
      items: z.array(itemSchema),
      page: z.number().int().openapi({ example: 1 }),
      pageSize: z.number().int().openapi({ example: 20 }),
      total: z.number().int().openapi({ example: 1 }),
    }),
  );
}

export const pageQueryParams = {
  page: z.coerce.number().int().min(1).default(1).optional().openapi({ example: 1 }),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional().openapi({ example: 20 }),
};
