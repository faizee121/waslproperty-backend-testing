import type { PrismaClient } from '@prisma/client';
import { maskPiiFields } from '../../../platform/privacy-policy.js';

export interface BackofficeSearchResult {
  entityType:
    | 'Organisation'
    | 'Property'
    | 'Space'
    | 'Person'
    | 'MaintenanceRequest'
    | 'WorkOrder'
    | 'Contractor'
    | 'Communication';
  id: string;
  label: string;
  organisation: { id: string; name: string } | null;
  context: string;
}

const PER_TYPE_LIMIT = 5;

/** Cross-organisation search across the real domain only — never an
 * invented entity type (no "documents", "tickets", "invoices"). PII in
 * Person results is masked through the same central policy used
 * everywhere else in the Backoffice. */
export class BackofficeSearchService {
  constructor(private readonly prisma: PrismaClient) {}

  async search(query: string, capabilities: readonly string[]): Promise<BackofficeSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    const insensitive = { contains: q, mode: 'insensitive' as const };

    const [
      organisations,
      properties,
      spaces,
      contacts,
      requests,
      workOrders,
      contractors,
      communications,
    ] = await Promise.all([
      this.prisma.organisation.findMany({
        where: { name: insensitive },
        take: PER_TYPE_LIMIT,
      }),
      this.prisma.property.findMany({
        where: { OR: [{ name: insensitive }, { code: insensitive }] },
        take: PER_TYPE_LIMIT,
        include: { organisation: { select: { id: true, name: true } } },
      }),
      this.prisma.space.findMany({
        where: { OR: [{ name: insensitive }, { code: insensitive }] },
        take: PER_TYPE_LIMIT,
        include: { property: { include: { organisation: { select: { id: true, name: true } } } } },
      }),
      this.prisma.propertyContact.findMany({
        where: {
          OR: [{ firstName: insensitive }, { lastName: insensitive }, { email: insensitive }],
        },
        take: PER_TYPE_LIMIT,
        include: { organisation: { select: { id: true, name: true } } },
      }),
      this.prisma.maintenanceRequest.findMany({
        where: { title: insensitive },
        take: PER_TYPE_LIMIT,
        include: {
          property: { include: { organisation: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.workOrder.findMany({
        where: { title: insensitive },
        take: PER_TYPE_LIMIT,
        include: {
          property: { include: { organisation: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.contractor.findMany({
        where: { name: insensitive },
        take: PER_TYPE_LIMIT,
        include: { organisation: { select: { id: true, name: true } } },
      }),
      this.prisma.communication.findMany({
        where: { title: insensitive },
        take: PER_TYPE_LIMIT,
        include: { organisation: { select: { id: true, name: true } } },
      }),
    ]);

    const results: BackofficeSearchResult[] = [];

    for (const org of organisations) {
      results.push({
        entityType: 'Organisation',
        id: org.id,
        label: org.name,
        organisation: { id: org.id, name: org.name },
        context: org.slug,
      });
    }

    for (const property of properties) {
      results.push({
        entityType: 'Property',
        id: property.id,
        label: property.name,
        organisation: property.organisation,
        context: `${property.code} · ${property.city}`,
      });
    }

    for (const space of spaces) {
      results.push({
        entityType: 'Space',
        id: space.id,
        label: space.name,
        organisation: space.property.organisation,
        context: `${space.property.name} · ${space.code}`,
      });
    }

    for (const contact of contacts) {
      const masked = maskPiiFields('PropertyContact', contact, capabilities);
      results.push({
        entityType: 'Person',
        id: contact.id,
        label: `${contact.firstName} ${contact.lastName}`,
        organisation: contact.organisation,
        context: masked.email,
      });
    }

    for (const request of requests) {
      results.push({
        entityType: 'MaintenanceRequest',
        id: request.id,
        label: request.title,
        organisation: request.property.organisation,
        context: `${request.property.name} · ${request.status}`,
      });
    }

    for (const workOrder of workOrders) {
      results.push({
        entityType: 'WorkOrder',
        id: workOrder.id,
        label: workOrder.title,
        organisation: workOrder.property.organisation,
        context: `${workOrder.property.name} · ${workOrder.status}`,
      });
    }

    for (const contractor of contractors) {
      results.push({
        entityType: 'Contractor',
        id: contractor.id,
        label: contractor.name,
        organisation: contractor.organisation,
        context: contractor.status,
      });
    }

    for (const communication of communications) {
      results.push({
        entityType: 'Communication',
        id: communication.id,
        label: communication.title,
        organisation: communication.organisation,
        context: communication.status,
      });
    }

    return results;
  }
}
