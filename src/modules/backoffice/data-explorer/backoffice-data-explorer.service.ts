import type { PlatformRole, Prisma, PrismaClient } from '@prisma/client';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../errors/AppError.js';
import type { PaginatedResult } from '../../../lib/pagination.js';
import { recordPlatformActivity } from '../../../platform/audit.js';
import {
  DATA_EXPLORER_MODELS,
  RELATION_DISPLAY_SELECT,
  formatRelationDisplay,
  type DataExplorerFieldMeta,
  type DataExplorerModelMeta,
} from '../../../platform/data-explorer-metadata.js';
import {
  canViewUnmaskedPii,
  maskPiiFields,
  SECRET_FIELDS,
} from '../../../platform/privacy-policy.js';
import type {
  DataExplorerDeleteInput,
  DataExplorerListQuery,
  DataExplorerUpdateInput,
} from './backoffice-data-explorer.schemas.js';

type Row = Record<string, unknown>;

interface GenericDelegate {
  findMany(args: Record<string, unknown>): Promise<Row[]>;
  count(args: Record<string, unknown>): Promise<number>;
  findUnique(args: Record<string, unknown>): Promise<Row | null>;
  update(args: Record<string, unknown>): Promise<Row>;
  delete(args: Record<string, unknown>): Promise<Row>;
}

function getDelegate(
  client: PrismaClient | Prisma.TransactionClient,
  delegateName: string,
): GenericDelegate {
  // delegateName always comes from our own metadata registry (never client
  // input), so it is always a valid Prisma Client property.
  return (client as unknown as Record<string, GenericDelegate>)[delegateName]!;
}

export function requireModelMeta(modelKey: string): DataExplorerModelMeta {
  const meta = DATA_EXPLORER_MODELS[modelKey];
  if (!meta) throw new NotFoundError(`Unknown or unsupported Data Explorer model: ${modelKey}`);
  return meta;
}

function buildSelect(meta: DataExplorerModelMeta, withRelations: boolean): Row {
  const select: Row = {};
  for (const field of meta.fields) select[field.name] = true;
  if (withRelations) {
    for (const rel of meta.relations) {
      const displayFields = RELATION_DISPLAY_SELECT[rel.targetModel] ?? [];
      const nested: Row = { id: true };
      for (const df of displayFields) nested[df] = true;
      select[rel.field] = { select: nested };
    }
  }
  return select;
}

function isPrismaCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === code
  );
}

function pick(row: Row, keys: string[]): Row {
  const out: Row = {};
  for (const key of keys) out[key] = row[key];
  return out;
}

/** Prisma.InputJsonValue has no Date/Decimal case — the audit log stores
 * plain JSON, so every changed value is normalized to a JSON-safe form
 * before being recorded, exactly like every other Backoffice mutation. */
function toAuditValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'object' &&
    'toString' in value &&
    typeof (value as { toString(): string }).toString === 'function'
  ) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName === 'Decimal') return (value as { toString(): string }).toString();
  }
  return value;
}

function sanitizeRecord(
  meta: DataExplorerModelMeta,
  row: Row,
  capabilities: readonly string[],
): Row {
  const secretFields = SECRET_FIELDS[meta.model];
  let out = row;
  if (secretFields?.length) {
    out = { ...out };
    for (const field of secretFields) delete out[field];
  }
  return maskPiiFields(meta.model, out, capabilities);
}

function buildWhere(meta: DataExplorerModelMeta, query: DataExplorerListQuery): Row {
  const clauses: Row[] = [];

  if (query.search) {
    const or: Row[] = [{ id: { equals: query.search } }];
    for (const field of meta.searchableFields) {
      or.push({ [field]: { contains: query.search, mode: 'insensitive' } });
    }
    clauses.push({ OR: or });
  }

  if (query.filters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query.filters);
    } catch {
      throw new ValidationError('filters must be valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('filters must be a JSON object of field: value pairs');
    }
    for (const [key, value] of Object.entries(parsed as Row)) {
      const fieldMeta = meta.fields.find((f) => f.name === key);
      if (!fieldMeta || !['enum', 'boolean', 'string'].includes(fieldMeta.type)) {
        throw new ValidationError(`${key} is not a filterable field on ${meta.model}`);
      }
      if (
        fieldMeta.type === 'enum' &&
        (typeof value !== 'string' || !fieldMeta.enumValues?.includes(value))
      ) {
        throw new ValidationError(`Invalid filter value for ${key}`);
      }
      if (fieldMeta.type === 'boolean' && typeof value !== 'boolean') {
        throw new ValidationError(`Invalid filter value for ${key}`);
      }
      if (fieldMeta.type === 'string' && typeof value !== 'string') {
        throw new ValidationError(`Invalid filter value for ${key}`);
      }
      clauses.push({ [key]: value });
    }
  }

  if (clauses.length === 0) return {};
  return clauses.length === 1 ? (clauses[0] as Row) : { AND: clauses };
}

function coerceFieldValue(fieldMeta: DataExplorerFieldMeta, value: unknown): unknown {
  switch (fieldMeta.type) {
    case 'string':
    case 'text': {
      if (value === null) return null;
      if (typeof value !== 'string')
        throw new ValidationError(`${fieldMeta.name} must be a string`);
      return value.trim();
    }
    case 'int': {
      if (value === null) return null;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ValidationError(`${fieldMeta.name} must be a whole number`);
      }
      return n;
    }
    case 'decimal': {
      if (value === null) return null;
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ValidationError(`${fieldMeta.name} must be a number`);
      }
      const s = String(value);
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
        throw new ValidationError(
          `${fieldMeta.name} must be a decimal with up to 2 decimal places`,
        );
      }
      return s;
    }
    case 'boolean': {
      if (typeof value !== 'boolean')
        throw new ValidationError(`${fieldMeta.name} must be true or false`);
      return value;
    }
    case 'datetime': {
      if (value === null) return null;
      if (typeof value !== 'string')
        throw new ValidationError(`${fieldMeta.name} must be an ISO date string`);
      const d = new Date(value);
      if (Number.isNaN(d.getTime()))
        throw new ValidationError(`${fieldMeta.name} is not a valid date`);
      return d;
    }
    case 'enum': {
      if (typeof value !== 'string' || !fieldMeta.enumValues?.includes(value)) {
        throw new ValidationError(
          `${fieldMeta.name} must be one of: ${fieldMeta.enumValues?.join(', ')}`,
        );
      }
      return value;
    }
    case 'stringArray': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new ValidationError(`${fieldMeta.name} must be an array of strings`);
      }
      return value;
    }
    case 'json':
    default:
      throw new ForbiddenError(`${fieldMeta.name} is not editable via Data Explorer`);
  }
}

export class BackofficeDataExplorerService {
  constructor(private readonly prisma: PrismaClient) {}

  /** One row count per allowed model, run in parallel — this is an internal
   * admin tool with a fixed, small model list, not a hot path. */
  async listModels() {
    const entries = Object.values(DATA_EXPLORER_MODELS);
    const counts = await Promise.all(
      entries.map((meta) => getDelegate(this.prisma, meta.delegate).count({})),
    );
    return entries.map((meta, i) => ({
      model: meta.model,
      label: meta.label,
      recordCount: counts[i],
      searchableFields: meta.searchableFields,
      fields: meta.fields,
      relations: meta.relations,
      deletable: meta.deletable,
    }));
  }

  async listRecords(
    modelKey: string,
    query: DataExplorerListQuery,
    capabilities: readonly string[],
  ): Promise<PaginatedResult<Row>> {
    const meta = requireModelMeta(modelKey);
    const delegate = getDelegate(this.prisma, meta.delegate);
    const where = buildWhere(meta, query);
    const select = buildSelect(meta, false);

    const [items, total] = await Promise.all([
      delegate.findMany({
        where,
        select,
        orderBy: { [meta.defaultOrderBy]: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      delegate.count({ where }),
    ]);

    return {
      items: items.map((row) => sanitizeRecord(meta, row, capabilities)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getRecord(modelKey: string, id: string, capabilities: readonly string[]) {
    const meta = requireModelMeta(modelKey);
    const delegate = getDelegate(this.prisma, meta.delegate);
    const row = await delegate.findUnique({ where: { id }, select: buildSelect(meta, true) });
    if (!row) throw new NotFoundError(`${meta.label} not found`);

    const relations = meta.relations.map((rel) => {
      const related = row[rel.field] as Row | null;
      return {
        field: rel.field,
        label: rel.label,
        targetModel: rel.targetModel,
        id: (related?.id as string | undefined) ?? null,
        display: formatRelationDisplay(rel.targetModel, related),
      };
    });

    const flat = pick(
      row,
      meta.fields.map((f) => f.name),
    );
    return { record: sanitizeRecord(meta, flat, capabilities), relations };
  }

  async updateRecord(
    modelKey: string,
    id: string,
    input: DataExplorerUpdateInput,
    actor: { employeeId: string; platformRole: PlatformRole },
    capabilities: readonly string[],
  ) {
    const meta = requireModelMeta(modelKey);
    const { changes, reason } = input;

    const data: Row = {};
    for (const [key, value] of Object.entries(changes)) {
      const fieldMeta = meta.fields.find((f) => f.name === key);
      if (!fieldMeta)
        throw new ValidationError(`${key} is not a recognised field on ${meta.model}`);
      if (!fieldMeta.editable) throw new ForbiddenError(`${key} is not editable on ${meta.model}`);
      if (fieldMeta.piiSensitive && !canViewUnmaskedPii(capabilities)) {
        throw new ForbiddenError(`Editing ${key} requires PII visibility`);
      }
      data[key] = coerceFieldValue(fieldMeta, value);
    }

    const delegate = getDelegate(this.prisma, meta.delegate);
    const changedKeys = Object.keys(data);
    const existing = await delegate.findUnique({
      where: { id },
      select: pick(buildSelect(meta, false), changedKeys),
    });
    if (!existing) throw new NotFoundError(`${meta.label} not found`);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const txDelegate = getDelegate(tx, meta.delegate);
        const result = await txDelegate.update({
          where: { id },
          data,
          select: buildSelect(meta, false),
        });

        await recordPlatformActivity(tx, {
          actorEmployeeId: actor.employeeId,
          platformRole: actor.platformRole,
          action: 'dataExplorer.recordUpdated',
          entityType: meta.model,
          entityId: id,
          reason,
          before: Object.fromEntries(
            changedKeys.map((k) => [k, toAuditValue(existing[k])]),
          ) as Prisma.InputJsonValue,
          after: Object.fromEntries(
            changedKeys.map((k) => [k, toAuditValue(result[k])]),
          ) as Prisma.InputJsonValue,
        });

        return result;
      });

      return sanitizeRecord(meta, updated, capabilities);
    } catch (err) {
      if (isPrismaCode(err, 'P2002'))
        throw new ConflictError('A record with that value already exists');
      if (isPrismaCode(err, 'P2025')) throw new NotFoundError(`${meta.label} not found`);
      throw err;
    }
  }

  /** PLATFORM_SUPER_ADMIN only, enforced at the route level
   * (requirePlatformSuperAdmin) — not repeated here, since this service has
   * no access to the actor's role/capabilities beyond what's passed in.
   * Blocked entirely for the audit/log-shaped models (deletable: false)
   * regardless of who's asking. Postgres's own foreign-key constraints are
   * the only referential-integrity guard — a row other records still point
   * to fails with a clear P2003, not a silent orphan. */
  async deleteRecord(
    modelKey: string,
    id: string,
    input: DataExplorerDeleteInput,
    actor: { employeeId: string; platformRole: PlatformRole },
  ) {
    const meta = requireModelMeta(modelKey);
    if (!meta.deletable) {
      throw new ForbiddenError(`${meta.model} records cannot be deleted via Data Explorer`);
    }

    const delegate = getDelegate(this.prisma, meta.delegate);
    const existing = await delegate.findUnique({ where: { id }, select: buildSelect(meta, false) });
    if (!existing) throw new NotFoundError(`${meta.label} not found`);

    try {
      await this.prisma.$transaction(async (tx) => {
        const txDelegate = getDelegate(tx, meta.delegate);
        await txDelegate.delete({ where: { id } });

        await recordPlatformActivity(tx, {
          actorEmployeeId: actor.employeeId,
          platformRole: actor.platformRole,
          action: 'dataExplorer.recordDeleted',
          entityType: meta.model,
          entityId: id,
          reason: input.reason,
          before: Object.fromEntries(
            Object.entries(existing).map(([k, v]) => [k, toAuditValue(v)]),
          ) as Prisma.InputJsonValue,
        });
      });
    } catch (err) {
      if (isPrismaCode(err, 'P2025')) throw new NotFoundError(`${meta.label} not found`);
      if (isPrismaCode(err, 'P2003')) {
        throw new ConflictError(
          `Cannot delete this ${meta.label}: other records still reference it.`,
        );
      }
      throw err;
    }
  }
}
