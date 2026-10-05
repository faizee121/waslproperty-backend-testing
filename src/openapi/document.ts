import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../config/env.js';
import { registry } from './registry.js';

// Side-effect imports: each of these calls registry.registerPath(...) for
// every route in its module. Order does not matter — they all populate the
// same shared registry — but every one must be imported before
// buildOpenApiDocument() runs, or its routes simply won't appear.
import './paths/auth.paths.js';
import './paths/organisations.paths.js';
import './paths/properties.paths.js';
import './paths/spaces.paths.js';
import './paths/strata.paths.js';
import './paths/people.paths.js';
import './paths/invites.paths.js';
import './paths/maintenance.paths.js';
import './paths/contractors.paths.js';
import './paths/quotes.paths.js';
import './paths/work-orders.paths.js';
import './paths/communications.paths.js';
import './paths/saved-audiences.paths.js';
import './paths/notifications.paths.js';
import './paths/dashboard.paths.js';
import './paths/ai.paths.js';
import './paths/property-documents.paths.js';
import './paths/integrations.paths.js';
import './paths/platform.paths.js';

let cachedDocument: ReturnType<OpenApiGeneratorV31['generateDocument']> | undefined;

/**
 * Builds the full OpenAPI 3.1 document from every registered path and
 * component schema. Cached after the first call — the registry is
 * populated once, at module-import time, and never changes while the
 * process is running.
 */
export function getOpenApiDocument() {
  if (!cachedDocument) {
    const generator = new OpenApiGeneratorV31(registry.definitions);
    cachedDocument = generator.generateDocument({
      openapi: '3.1.0',
      info: {
        title: 'WaslProp API',
        version: '1.0.0',
        description:
          'WaslProp property and strata operations API.\n\n' +
          'This document is generated directly from the live route definitions and the same Zod ' +
          'schemas the backend uses to validate requests — it describes what is actually ' +
          'implemented, not a roadmap. A few notes on how to read it:\n\n' +
          '- **Identifiers**: internal records use CUIDs; several customer-facing resources ' +
          '(Property, Space, Maintenance Request, Work Order, Quote Round, Communication) also ' +
          'carry a short public reference (e.g. `PROP-K7M4Q2`) and most endpoints accept either ' +
          'interchangeably in their `{id}` path parameter. See ADR-001 and ADR-002.\n' +
          '- **Response shapes**: controllers return their Prisma payload directly; there is no ' +
          'separate DTO mapping layer. The schemas here document the real contract, but the exact ' +
          'set of nested relations present can vary slightly by endpoint — see "API Technical Debt" ' +
          'in the OpenAPI/Swagger milestone report.\n' +
          '- **Authorization**: this document describes the capability/role each endpoint requires; ' +
          'the backend’s `AuthorizationService` remains the sole source of truth. Nothing here ' +
          'grants access on its own.\n' +
          '- **Platform-tagged endpoints** are internal WaslProperty Backoffice tooling, never ' +
          'customer-callable, and require a structurally separate Employee session.',
        contact: { name: 'WaslProp Engineering' },
      },
      servers: [
        {
          url: `${env.BACKEND_PUBLIC_URL}/api/v1`,
          description: 'This environment (local or staging, whichever generated this document).',
        },
        { url: '/api/v1', description: 'Relative to whichever host is serving this document.' },
      ],
      tags: [
        { name: 'Authentication' },
        { name: 'Organisations' },
        { name: 'Properties' },
        { name: 'Strata' },
        { name: 'Lots & Areas' },
        { name: 'People' },
        { name: 'Maintenance' },
        { name: 'Contractors' },
        { name: 'Procurement' },
        { name: 'Work Orders' },
        { name: 'Variations' },
        { name: 'Approvals' },
        { name: 'Communications' },
        { name: 'Notifications' },
        { name: 'Dashboard' },
        { name: 'Wasl AI' },
        { name: 'Property Documents' },
        { name: 'Integrations' },
        {
          name: 'Platform',
          description: 'Internal WaslProperty Backoffice tooling — never customer-callable.',
        },
      ],
    });
  }
  return cachedDocument;
}
