import type { PrismaClient } from '@prisma/client';
import { getOccupiedSpaceIds } from '../../../lib/occupancy.js';
import type { PaginatedResult } from '../../../lib/pagination.js';
import type { PaginationQuery } from '../../../lib/pagination.js';
import { maskPiiFields } from '../../../platform/privacy-policy.js';

/** Global, cross-organisation property-data views — always with
 * organisation context attached, since these are internal investigation
 * lists, not a single tenant's own property manager UI. */
export class BackofficePropertyDataService {
  constructor(private readonly prisma: PrismaClient) {}

  async listProperties(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.property.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          organisation: { select: { id: true, name: true } },
          _count: { select: { spaces: true } },
        },
      }),
      this.prisma.property.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async listSpaces(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.space.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          property: {
            select: { id: true, name: true, organisation: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.space.count({ where }),
    ]);
    const occupiedSpaceIds = await getOccupiedSpaceIds(
      this.prisma,
      items.map((s) => s.id),
    );
    return {
      items: items.map((s) => ({
        ...s,
        occupancy: occupiedSpaceIds.has(s.id) ? 'OCCUPIED' : 'VACANT',
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async listMemberships(
    query: PaginationQuery,
    capabilities: readonly string[],
  ): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? {
          contact: {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' as const } },
              { lastName: { contains: query.search, mode: 'insensitive' as const } },
            ],
          },
        }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.propertyMembership.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          contact: { select: { id: true, firstName: true, lastName: true, email: true } },
          property: {
            select: { id: true, name: true, organisation: { select: { id: true, name: true } } },
          },
          space: { select: { id: true, name: true } },
        },
      }),
      this.prisma.propertyMembership.count({ where }),
    ]);
    return {
      items: items.map((m) => ({
        ...m,
        contact: maskPiiFields('PropertyContact', m.contact, capabilities),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}
