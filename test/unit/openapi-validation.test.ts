import { describe, expect, it } from 'vitest';
import { getOpenApiDocument } from '../../src/openapi/document.js';

/**
 * A lightweight, dependency-free structural validation of the generated
 * OpenAPI document — catches the mistakes most likely to slip in when a
 * path file is hand-written: a $ref to a component that was never
 * registered, two operations accidentally sharing an operationId, or an
 * operation with no responses at all. Not a full OpenAPI-3.1-meta-schema
 * validation (that would need a sizeable extra dependency for marginal
 * extra coverage here, since every schema already flows through
 * zod-to-openapi's own generator); this catches the specific failure modes
 * called out in the OpenAPI/Swagger milestone brief.
 */

function collectRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      else collectRefs(value, refs);
    }
  }
}

describe('OpenAPI document structure', () => {
  const doc = getOpenApiDocument();

  it('is a 3.1.x document', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
  });

  it('has at least one documented path', () => {
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('resolves every $ref to a component that actually exists', () => {
    const refs = new Set<string>();
    collectRefs(doc.paths, refs);
    collectRefs(doc.components, refs);

    const unresolved: string[] = [];
    for (const ref of refs) {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
      if (!match) {
        unresolved.push(`${ref} (not a local #/components/... reference)`);
        continue;
      }
      const [, section, name] = match;
      const components = doc.components as Record<string, Record<string, unknown>> | undefined;
      if (!components?.[section as string]?.[name as string]) {
        unresolved.push(ref);
      }
    }

    expect(unresolved, `Dangling $ref(s):\n${unresolved.join('\n')}`).toEqual([]);
  });

  it('has no duplicate operationId across the whole document', () => {
    const seen = new Map<string, string[]>();
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, { operationId?: string }>,
      )) {
        const id = operation.operationId;
        if (!id) continue;
        const locations = seen.get(id) ?? [];
        locations.push(`${method.toUpperCase()} ${path}`);
        seen.set(id, locations);
      }
    }

    const duplicates = [...seen.entries()].filter(([, locations]) => locations.length > 1);

    expect(
      duplicates,
      `Duplicate operationId(s):\n${duplicates.map(([id, locs]) => `${id}: ${locs.join(', ')}`).join('\n')}`,
    ).toEqual([]);
  });

  it('gives every operation at least one response', () => {
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, { responses?: object }>,
      )) {
        if (!operation.responses || Object.keys(operation.responses).length === 0) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(missing, `Operation(s) with no responses defined:\n${missing.join('\n')}`).toEqual([]);
  });

  it('never embeds an obvious secret-shaped value anywhere in the document', () => {
    const serialized = JSON.stringify(doc);
    // Looks for common leaked-credential shapes rather than specific known
    // values — a real secret would never knowingly be typed into a path
    // file, but this guards against ever copy-pasting one from a .env by
    // mistake (see Security review item in the milestone report).
    expect(serialized).not.toMatch(/AKIA[0-9A-Z]{16}/); // AWS access key id
    expect(serialized).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\/[^@"']+:[^@"'\s]+@/); // DB URL with credentials
  });
});
