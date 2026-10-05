import { createHash } from 'node:crypto';

/**
 * Best-effort SQL statement classification for the Raw SQL Console — used
 * for UI labeling, audit metadata, and deciding which Prisma raw-query
 * method to call (queryRaw vs executeRaw). This is NOT a SQL parser and
 * deliberately never used as a security allow/deny gate: the Raw SQL
 * Console's access boundary is PLATFORM_SUPER_ADMIN plus the explicit
 * enable/write-enable server config, never "which keyword did we detect."
 */
export type SqlStatementKind =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'CREATE'
  | 'ALTER'
  | 'DROP'
  | 'TRUNCATE'
  | 'WITH'
  | 'EXPLAIN'
  | 'OTHER';

const KNOWN_KEYWORDS = new Set<string>([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'WITH',
  'EXPLAIN',
]);

export interface SqlStatementClassification {
  kind: SqlStatementKind;
  /** Anything that isn't a read-only SELECT/EXPLAIN. A writable CTE
   * (WITH ... AS (INSERT/UPDATE/DELETE ...) ...) is conservatively treated
   * as mutating even though its outer keyword is WITH. */
  isMutating: boolean;
  /** Rough count of semicolon-separated statements after stripping
   * comments — a heuristic (a semicolon inside a string literal will
   * overcount), reported as-is rather than relied on for any decision. */
  statementCount: number;
  /** Whether we should call $queryRawUnsafe (expect rows back) instead of
   * $executeRawUnsafe (expect an affected-row count). */
  returnsRows: boolean;
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function firstKeyword(strippedSql: string): string {
  const match = strippedSql.trim().match(/^[a-zA-Z]+/);
  return match ? match[0].toUpperCase() : '';
}

export function classifySqlStatement(sql: string): SqlStatementClassification {
  const stripped = stripSqlComments(sql);
  const statementCount = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const first = firstKeyword(stripped);
  const kind: SqlStatementKind = KNOWN_KEYWORDS.has(first) ? (first as SqlStatementKind) : 'OTHER';

  let isMutating: boolean;
  if (kind === 'SELECT' || kind === 'EXPLAIN') {
    isMutating = false;
  } else if (kind === 'WITH') {
    isMutating = /\b(INSERT|UPDATE|DELETE)\b/i.test(stripped);
  } else {
    // Unrecognized first keyword defaults to mutating — the safer failure
    // mode is requiring a reason + confirmation for something we can't
    // confidently classify as read-only.
    isMutating = true;
  }

  const returnsRows =
    kind === 'SELECT' || kind === 'EXPLAIN' || kind === 'WITH' || /\bRETURNING\b/i.test(stripped);

  return { kind, isMutating, statementCount, returnsRows };
}

/**
 * Redacts every quoted literal in the SQL text so the sanitized form can be
 * safely stored in the platform audit log without risking a leaked PII or
 * secret value that happened to appear as a literal (e.g.
 * `WHERE email = 'someone@example.com'`). Structure (tables, columns,
 * clauses) is preserved; values are not.
 */
export function sanitizeSqlForAudit(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\$[\s\S]*?\$\$/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(sanitizeSqlForAudit(sql)).digest('hex').slice(0, 16);
}

/** Applies the same literal-redaction used for the query itself to a
 * database error message, PLUS a second pass specifically for Postgres's
 * constraint-violation format, which echoes the offending value back
 * unquoted — `Key (email)=(x@y.com) already exists` — a real leak the
 * quote-stripping pass alone does not catch. */
export function sanitizeErrorForAudit(message: string): string {
  const withoutConstraintValues = message.replace(/\)=\([^)]*\)/g, ')=(?)');
  return sanitizeSqlForAudit(withoutConstraintValues).slice(0, 1000);
}
