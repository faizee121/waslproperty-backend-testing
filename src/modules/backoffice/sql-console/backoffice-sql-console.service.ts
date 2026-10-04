import type { PlatformRole, PrismaClient } from '@prisma/client';
import { env } from '../../../config/env.js';
import { ForbiddenError, ValidationError } from '../../../errors/AppError.js';
import { recordPlatformActivity } from '../../../platform/audit.js';
import {
  PII_FIELDS,
  SECRET_FIELDS,
  canViewUnmaskedPiiInSql,
  maskField,
} from '../../../platform/privacy-policy.js';
import {
  classifySqlStatement,
  sanitizeErrorForAudit,
  sanitizeSqlForAudit,
  sqlFingerprint,
  type SqlStatementKind,
} from '../../../lib/sql-statement.js';

type Row = Record<string, unknown>;

const SECRET_COLUMN_NAMES = new Set(
  Object.values(SECRET_FIELDS)
    .flat()
    .map((f) => f.toLowerCase()),
);
const PII_COLUMN_NAMES = new Set(
  Object.values(PII_FIELDS)
    .flat()
    .map((f) => f.toLowerCase()),
);

const REDACTED = '[REDACTED]';

/** Normalizes a raw driver value into something JSON-safe and sensible on
 * the wire — Postgres bigint/numeric columns and timestamps otherwise
 * either throw on JSON.stringify (BigInt) or serialize unhelpfully. */
function serializeSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value && typeof value === 'object' && 'toString' in value) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName === 'Decimal') return (value as { toString(): string }).toString();
  }
  return value;
}

/** The only place that decides whether a raw-SQL result column's value
 * leaves the process as-is, masked, or redacted — reusing the exact same
 * central classification (PII_FIELDS/SECRET_FIELDS) and masking function
 * (maskField) as every other Backoffice surface. Column-name matching is
 * the only thing that can work for arbitrary, un-modeled SQL results —
 * an aliased column (`SELECT "passwordHash" AS x`) can't be identified and
 * is knowingly out of scope, exactly as the design brief anticipates. */
function redactAndSerializeRow(row: Row, capabilities: readonly string[]): Row {
  const unmask = canViewUnmaskedPiiInSql(capabilities);
  const out: Row = {};
  for (const [key, rawValue] of Object.entries(row)) {
    const lower = key.toLowerCase();
    if (SECRET_COLUMN_NAMES.has(lower)) {
      out[key] = rawValue === null ? null : REDACTED;
      continue;
    }
    const value = serializeSqlValue(rawValue);
    if (PII_COLUMN_NAMES.has(lower) && !unmask && typeof value === 'string' && value.length > 0) {
      out[key] = maskField(key, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function requiredConfirmationPhrase(isMutating: boolean, isProduction: boolean): string | null {
  if (!isMutating) return null;
  return isProduction ? 'PRODUCTION' : 'CONFIRM';
}

export interface ExecuteSqlResult {
  success: boolean;
  kind: SqlStatementKind;
  statementCount: number;
  isMutating: boolean;
  rows?: Row[];
  rowCount?: number;
  truncated: boolean;
  affectedRows?: number;
  durationMs: number;
  errorMessage?: string;
}

export class BackofficeSqlConsoleService {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(
    input: { sql: string; reason?: string; confirmationPhrase?: string },
    actor: { employeeId: string; platformRole: PlatformRole },
    capabilities: readonly string[],
  ): Promise<ExecuteSqlResult> {
    if (!env.BACKOFFICE_RAW_SQL_ENABLED) {
      throw new ForbiddenError('Raw SQL execution is disabled by server configuration.');
    }

    const { sql, reason, confirmationPhrase } = input;
    const { kind, isMutating, statementCount, returnsRows } = classifySqlStatement(sql);
    const isProduction = env.NODE_ENV === 'production';

    if (isMutating) {
      if (!capabilities.includes('database.sql.write')) {
        throw new ForbiddenError('You do not have permission to run a mutating SQL statement.');
      }
      if (!env.BACKOFFICE_RAW_SQL_WRITE_ENABLED) {
        throw new ForbiddenError(
          isProduction
            ? 'Raw SQL writes are disabled in production by server configuration.'
            : 'Raw SQL writes are disabled by server configuration.',
        );
      }
      if (!reason?.trim()) {
        throw new ValidationError(
          'A reason is required for any statement that changes data or schema.',
        );
      }
      const required = requiredConfirmationPhrase(isMutating, isProduction);
      if (confirmationPhrase?.trim() !== required) {
        throw new ValidationError(
          `Type "${required}" to confirm this ${isProduction ? 'production ' : ''}mutating statement.`,
        );
      }
    } else if (!capabilities.includes('database.sql.read')) {
      throw new ForbiddenError('You do not have permission to run SQL statements.');
    }

    const startedAt = Date.now();
    let rows: Row[] | undefined;
    let affectedRows: number | undefined;
    let errorMessage: string | undefined;
    let success = true;

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = ${env.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS}`,
          );
          if (returnsRows) {
            const r = await tx.$queryRawUnsafe<Row[]>(sql);
            return { rows: r };
          }
          const count = await tx.$executeRawUnsafe(sql);
          return { affectedRows: count };
        },
        { timeout: env.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS + 5000, maxWait: 5000 },
      );
      rows = result.rows;
      affectedRows = result.affectedRows;
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - startedAt;

    let responseRows = rows;
    let truncated = false;
    if (responseRows) {
      if (responseRows.length > env.BACKOFFICE_SQL_RESULT_ROW_LIMIT) {
        truncated = true;
        responseRows = responseRows.slice(0, env.BACKOFFICE_SQL_RESULT_ROW_LIMIT);
      }
      responseRows = responseRows.map((row) => redactAndSerializeRow(row, capabilities));
    }

    await recordPlatformActivity(this.prisma, {
      actorEmployeeId: actor.employeeId,
      platformRole: actor.platformRole,
      action: 'sqlConsole.executed',
      entityType: 'RawSqlExecution',
      reason: reason?.trim() ? reason : null,
      after: {
        sanitizedQuery: sanitizeSqlForAudit(sql),
        queryFingerprint: sqlFingerprint(sql),
        statementKind: kind,
        statementCount,
        isMutating,
        environment: env.NODE_ENV,
        success,
        durationMs,
        rowCount: rows?.length ?? null,
        affectedRows: affectedRows ?? null,
        errorMessage: success || !errorMessage ? null : sanitizeErrorForAudit(errorMessage),
      },
    });

    return {
      success,
      kind,
      statementCount,
      isMutating,
      rows: responseRows,
      rowCount: rows?.length,
      truncated,
      affectedRows,
      durationMs,
      errorMessage,
    };
  }

  async listHistory(query: { page: number; pageSize: number }) {
    const where = { action: 'sqlConsole.executed' };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.platformAuditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actorEmployee: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.platformAuditEvent.count({ where }),
    ]);

    return {
      items: items.map((e) => ({
        id: e.id,
        actor: `${e.actorEmployee.firstName} ${e.actorEmployee.lastName}`,
        platformRole: e.platformRole,
        reason: e.reason,
        environment: e.environment,
        after: e.after,
        createdAt: e.createdAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}
