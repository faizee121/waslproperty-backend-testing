import listEndpoints from 'express-list-endpoints';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { getOpenApiDocument } from '../../src/openapi/document.js';

/**
 * Prevents "new endpoint added, Swagger forgotten" drift: every real,
 * customer-/platform-facing route registered on the Express app must have a
 * matching operation in the generated OpenAPI document, and vice versa (a
 * documented operation that no longer exists is equally a bug — a stale
 * contract). Routes genuinely outside the documented API contract are
 * listed in EXCLUDED_ROUTES with a reason; do not add to that list to make
 * a failing test pass without a real justification.
 */
const EXCLUDED_ROUTES = new Set<string>([
  // Liveness probe — infrastructure, not part of the API contract.
  'GET /health',
  // Serves this very document — documenting it would be circular.
  'GET /api/openapi.json',
  // Pre-API-versioning connectivity check with no business meaning.
  'GET /api/v1/ping',
]);

function normalizePath(expressPath: string): string {
  return expressPath.replace(/^\/api\/v1/, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

function realRoutes(): Set<string> {
  const app = createApp();
  const routes = new Set<string>();
  for (const endpoint of listEndpoints(app)) {
    for (const method of endpoint.methods) {
      const rawKey = `${method} ${endpoint.path}`;
      if (EXCLUDED_ROUTES.has(rawKey)) continue;
      routes.add(`${method} ${normalizePath(endpoint.path)}`);
    }
  }
  return routes;
}

function documentedOperations(): Set<string> {
  const doc = getOpenApiDocument();
  const operations = new Set<string>();
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(methods as object)) {
      operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

describe('OpenAPI route coverage', () => {
  it('documents every registered route, and documents nothing else', () => {
    const real = realRoutes();
    const documented = documentedOperations();

    const missing = [...real].filter((route) => !documented.has(route)).sort();
    const stale = [...documented].filter((route) => !real.has(route)).sort();

    expect(
      missing,
      `Route(s) registered on the app but missing from the OpenAPI document. Add a ` +
        `registry.registerPath(...) call for each in src/openapi/paths/, or add it to ` +
        `EXCLUDED_ROUTES with a reason if it is genuinely outside the API contract:\n` +
        missing.join('\n'),
    ).toEqual([]);

    expect(
      stale,
      `Operation(s) documented in the OpenAPI document that no longer exist as real routes ` +
        `— the route was removed/renamed without updating src/openapi/paths/:\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
