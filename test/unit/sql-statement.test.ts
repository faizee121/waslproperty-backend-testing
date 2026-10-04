import { describe, expect, it } from 'vitest';
import {
  classifySqlStatement,
  sanitizeErrorForAudit,
  sanitizeSqlForAudit,
  sqlFingerprint,
} from '../../src/lib/sql-statement.js';

describe('classifySqlStatement', () => {
  it('classifies a plain SELECT as read-only, returning rows', () => {
    const r = classifySqlStatement("SELECT * FROM organisations WHERE id = 'org_1'");
    expect(r.kind).toBe('SELECT');
    expect(r.isMutating).toBe(false);
    expect(r.returnsRows).toBe(true);
    expect(r.statementCount).toBe(1);
  });

  it('classifies INSERT/UPDATE/DELETE as mutating', () => {
    expect(classifySqlStatement('INSERT INTO x (a) VALUES (1)').isMutating).toBe(true);
    expect(classifySqlStatement('UPDATE x SET a = 1').isMutating).toBe(true);
    expect(classifySqlStatement('DELETE FROM x').isMutating).toBe(true);
  });

  it('classifies DDL (CREATE/ALTER/DROP/TRUNCATE) as mutating', () => {
    expect(classifySqlStatement('CREATE TABLE x (id text)').isMutating).toBe(true);
    expect(classifySqlStatement('ALTER TABLE x ADD COLUMN y text').isMutating).toBe(true);
    expect(classifySqlStatement('DROP TABLE x').isMutating).toBe(true);
    expect(classifySqlStatement('TRUNCATE x').isMutating).toBe(true);
  });

  it('an UPDATE/DELETE/INSERT with RETURNING is expected to return rows', () => {
    expect(classifySqlStatement('UPDATE x SET a = 1 RETURNING id').returnsRows).toBe(true);
    expect(classifySqlStatement('DELETE FROM x RETURNING id').returnsRows).toBe(true);
  });

  it('a DDL statement does not expect rows back', () => {
    expect(classifySqlStatement('DROP TABLE x').returnsRows).toBe(false);
  });

  it('treats a read-only CTE (WITH ... SELECT) as non-mutating', () => {
    const r = classifySqlStatement('WITH recent AS (SELECT id FROM x) SELECT * FROM recent');
    expect(r.kind).toBe('WITH');
    expect(r.isMutating).toBe(false);
    expect(r.returnsRows).toBe(true);
  });

  it('conservatively treats a writable CTE as mutating', () => {
    const r = classifySqlStatement(
      'WITH deleted AS (DELETE FROM x RETURNING id) SELECT count(*) FROM deleted',
    );
    expect(r.kind).toBe('WITH');
    expect(r.isMutating).toBe(true);
  });

  it('defaults an unrecognized first keyword to mutating (safer failure mode)', () => {
    expect(classifySqlStatement('VACUUM ANALYZE x').isMutating).toBe(true);
    expect(classifySqlStatement('VACUUM ANALYZE x').kind).toBe('OTHER');
  });

  it('counts multiple semicolon-separated statements after stripping comments', () => {
    const sql = 'SELECT 1; -- a comment with a ; inside\nSELECT 2;';
    expect(classifySqlStatement(sql).statementCount).toBe(2);
  });

  it('ignores a trailing semicolon and blank statements when counting', () => {
    expect(classifySqlStatement('SELECT 1;').statementCount).toBe(1);
    expect(classifySqlStatement('SELECT 1;;;').statementCount).toBe(1);
  });
});

describe('sanitizeSqlForAudit', () => {
  it('redacts single-quoted string literals but preserves structure', () => {
    const sanitized = sanitizeSqlForAudit(
      "UPDATE users SET email = 'someone@example.com' WHERE id = 'usr_1'",
    );
    expect(sanitized).not.toContain('someone@example.com');
    expect(sanitized).not.toContain('usr_1');
    expect(sanitized).toContain('UPDATE users SET email = ? WHERE id = ?');
  });

  it("handles doubled '' escape sequences inside a literal", () => {
    const sanitized = sanitizeSqlForAudit("SELECT * FROM x WHERE name = 'O''Brien'");
    expect(sanitized).not.toContain("O''Brien");
    expect(sanitized).toContain('?');
  });

  it('caps output length defensively', () => {
    const huge = "SELECT '" + 'a'.repeat(5000) + "'";
    expect(sanitizeSqlForAudit(huge).length).toBeLessThanOrEqual(2000);
  });
});

describe('sqlFingerprint', () => {
  it('produces the same fingerprint for the same query shape with different literal values', () => {
    const a = sqlFingerprint("SELECT * FROM x WHERE id = 'abc'");
    const b = sqlFingerprint("SELECT * FROM x WHERE id = 'xyz'");
    expect(a).toBe(b);
  });

  it('produces a different fingerprint for a different query shape', () => {
    const a = sqlFingerprint('SELECT * FROM x');
    const b = sqlFingerprint('SELECT * FROM y');
    expect(a).not.toBe(b);
  });
});

describe('sanitizeErrorForAudit', () => {
  it('redacts a quoted literal value echoed back in a constraint-violation-style error message', () => {
    const sanitized = sanitizeErrorForAudit(
      'duplicate key value violates unique constraint "users_email_key" Key (email)=(\'leaked@example.com\') already exists.',
    );
    expect(sanitized).not.toContain('leaked@example.com');
  });

  it("redacts Postgres's real unquoted Key (col)=(value) constraint error format", () => {
    const sanitized = sanitizeErrorForAudit(
      'duplicate key value violates unique constraint "x" Key (email)=(leaked@example.com) already exists.',
    );
    expect(sanitized).not.toContain('leaked@example.com');
  });
});
