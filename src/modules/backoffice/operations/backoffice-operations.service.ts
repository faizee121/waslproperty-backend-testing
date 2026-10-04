import type { PrismaClient } from '@prisma/client';
import type { PaginatedResult, PaginationQuery } from '../../../lib/pagination.js';

export class BackofficeOperationsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listRequests(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? { title: { contains: query.search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.maintenanceRequest.findMany({
        where,
        orderBy: { reportedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          property: {
            select: { id: true, name: true, organisation: { select: { id: true, name: true } } },
          },
          space: { select: { id: true, name: true } },
        },
      }),
      this.prisma.maintenanceRequest.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async listWorkOrders(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? { title: { contains: query.search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          property: {
            select: { id: true, name: true, organisation: { select: { id: true, name: true } } },
          },
          space: { select: { id: true, name: true } },
          contractor: { select: { id: true, name: true } },
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async listContractors(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const where = query.search
      ? { name: { contains: query.search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contractor.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { organisation: { select: { id: true, name: true } } },
      }),
      this.prisma.contractor.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async listQuotes(query: PaginationQuery): Promise<PaginatedResult<unknown>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contractorQuote.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          contractor: { select: { id: true, name: true } },
          workOrder: {
            select: {
              id: true,
              title: true,
              property: {
                select: {
                  id: true,
                  name: true,
                  organisation: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.contractorQuote.count(),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }
}
