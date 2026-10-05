import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Must run before any schema in the codebase is registered with the
// OpenAPI registry below — adds the `.openapi()` method to every Zod
// schema. Safe to call once, globally, regardless of which module's
// schemas (auth.schemas.ts, maintenance.schemas.ts, ...) were imported
// first, since it patches the shared Zod prototype rather than anything
// scoped to a single import.
extendZodWithOpenApi(z);

/**
 * The single OpenAPI registry every `paths/*.ts` file registers against.
 * Deliberately one shared instance (not one per module) — component
 * schemas (ApiError, PropertySummary, ...) are referenced across module
 * boundaries (e.g. Work Orders responses reference Contractor), and a
 * single registry is what makes `$ref`s resolve correctly in the
 * assembled document.
 */
export const registry = new OpenAPIRegistry();

export const SECURITY_CUSTOMER = [{ bearerAuth: [] }];
export const SECURITY_PLATFORM = [{ platformBearerAuth: [] }];
export const SECURITY_PUBLIC: Record<string, string[]>[] = [];

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Customer-facing access token, returned as `accessToken` by POST /auth/login, ' +
    'POST /auth/register, and POST /auth/refresh. Short-lived (~15 minutes); refreshed ' +
    'via the separate httpOnly `refreshToken` cookie, which Swagger UI cannot exercise ' +
    'directly (it is never sent as a header). Send as `Authorization: Bearer <accessToken>`.',
});

registry.registerComponent('securitySchemes', 'platformBearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'WaslProperty Backoffice (Platform/Employee) access token, returned by ' +
    'POST /backoffice/auth/login. Structurally separate from the customer `bearerAuth` ' +
    'token above — a customer token is rejected on every /backoffice/* route and vice ' +
    'versa. Used only by internal WaslProperty staff tooling, never by customers.',
});
