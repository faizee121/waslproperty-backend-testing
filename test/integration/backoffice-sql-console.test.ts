import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { resetDb, testPrisma } from '../helpers/db.js';
import { authHeader, createPlatformUser, registerTestUser } from '../helpers/auth.js';

const app = createApp();

async function platformLogin(username: string, password: string) {
  const res = await request(app).post('/api/v1/backoffice/auth/login').send({ username, password });
  return res.body.accessToken as string;
}

async function superAdminToken() {
  const { username, password } = await createPlatformUser();
  return platformLogin(username, password);
}

const original = {
  NODE_ENV: env.NODE_ENV,
  BACKOFFICE_RAW_SQL_ENABLED: env.BACKOFFICE_RAW_SQL_ENABLED,
  BACKOFFICE_RAW_SQL_WRITE_ENABLED: env.BACKOFFICE_RAW_SQL_WRITE_ENABLED,
  BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED: env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED,
  BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS: env.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS,
  BACKOFFICE_SQL_RESULT_ROW_LIMIT: env.BACKOFFICE_SQL_RESULT_ROW_LIMIT,
};

function resetEnv() {
  env.NODE_ENV = original.NODE_ENV;
  env.BACKOFFICE_RAW_SQL_ENABLED = original.BACKOFFICE_RAW_SQL_ENABLED;
  env.BACKOFFICE_RAW_SQL_WRITE_ENABLED = original.BACKOFFICE_RAW_SQL_WRITE_ENABLED;
  env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = original.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED;
  env.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS = original.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS;
  env.BACKOFFICE_SQL_RESULT_ROW_LIMIT = original.BACKOFFICE_SQL_RESULT_ROW_LIMIT;
}

describe('backoffice SQL console', () => {
  beforeAll(async () => {
    await testPrisma.$executeRawUnsafe('DROP TABLE IF EXISTS sql_console_test_scratch');
  });

  beforeEach(async () => {
    await resetDb();
    resetEnv();
    env.BACKOFFICE_RAW_SQL_ENABLED = true;
    env.BACKOFFICE_RAW_SQL_WRITE_ENABLED = true;
  });

  afterEach(async () => {
    resetEnv();
    await testPrisma.$executeRawUnsafe('DROP TABLE IF EXISTS sql_console_test_scratch');
  });

  afterAll(async () => {
    await testPrisma.$executeRawUnsafe('DROP TABLE IF EXISTS sql_console_test_scratch');
    await resetDb();
    await testPrisma.$disconnect();
  });

  describe('access', () => {
    it('allows PLATFORM_SUPER_ADMIN', async () => {
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT 1 AS one' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it.each(['PLATFORM_ADMIN', 'PLATFORM_SUPPORT', 'PLATFORM_DEVELOPER'] as const)(
      'rejects %s even though it may hold a database.sql.* capability',
      async (role) => {
        const { username, password } = await createPlatformUser({ role });
        const token = await platformLogin(username, password);
        const res = await request(app)
          .post('/api/v1/backoffice/sql-console/execute')
          .set(authHeader(token))
          .send({ sql: 'SELECT 1' });
        expect(res.status).toBe(403);
      },
    );

    it('rejects a customer/organisation session', async () => {
      const { accessToken } = await registerTestUser(app);
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(accessToken))
        .send({ sql: 'SELECT 1' });
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .send({ sql: 'SELECT 1' });
      expect(res.status).toBe(401);
    });
  });

  describe('execution', () => {
    it('runs a SELECT and returns rows', async () => {
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: "SELECT 1 AS n, 'hello' AS greeting" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kind).toBe('SELECT');
      expect(res.body.rows).toEqual([{ n: 1, greeting: 'hello' }]);
      expect(typeof res.body.durationMs).toBe('number');
    });

    it('runs DDL (CREATE TABLE)', async () => {
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: 'CREATE TABLE sql_console_test_scratch (id serial primary key, name text, email text)',
          reason: 'test: create scratch table',
          confirmationPhrase: 'CONFIRM',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kind).toBe('CREATE');
      expect(res.body.isMutating).toBe(true);
    });

    it('runs INSERT, UPDATE, then DELETE against a real table', async () => {
      const token = await superAdminToken();
      await testPrisma.$executeRawUnsafe(
        'CREATE TABLE sql_console_test_scratch (id serial primary key, name text, email text)',
      );

      const insertRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: "INSERT INTO sql_console_test_scratch (name, email) VALUES ('Ada', 'ada@example.com')",
          reason: 'test insert',
          confirmationPhrase: 'CONFIRM',
        });
      expect(insertRes.status).toBe(200);
      expect(insertRes.body.success).toBe(true);
      expect(insertRes.body.kind).toBe('INSERT');
      expect(insertRes.body.affectedRows).toBe(1);

      const updateRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: "UPDATE sql_console_test_scratch SET name = 'Ada Lovelace' WHERE name = 'Ada'",
          reason: 'test update',
          confirmationPhrase: 'CONFIRM',
        });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.kind).toBe('UPDATE');
      expect(updateRes.body.affectedRows).toBe(1);

      const deleteRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: "DELETE FROM sql_console_test_scratch WHERE name = 'Ada Lovelace'",
          reason: 'test delete',
          confirmationPhrase: 'CONFIRM',
        });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.kind).toBe('DELETE');
      expect(deleteRes.body.affectedRows).toBe(1);
    });

    it('allows an unconditional DELETE (no artificial WHERE-clause requirement)', async () => {
      const token = await superAdminToken();
      await testPrisma.$executeRawUnsafe(
        'CREATE TABLE sql_console_test_scratch (id serial primary key, name text)',
      );
      await testPrisma.$executeRawUnsafe(
        "INSERT INTO sql_console_test_scratch (name) VALUES ('a'), ('b'), ('c')",
      );

      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: 'DELETE FROM sql_console_test_scratch',
          reason: 'intentional full-table delete',
          confirmationPhrase: 'CONFIRM',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.affectedRows).toBe(3);
    });

    it('returns a database error safely as success:false rather than a 500', async () => {
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT * FROM this_table_does_not_exist_xyz' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.errorMessage).toBe('string');
      expect(res.body.errorMessage.toLowerCase()).toContain('this_table_does_not_exist_xyz');
    });

    it('enforces a real server-side statement timeout', async () => {
      env.BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS = 200;
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT pg_sleep(2)' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.errorMessage.toLowerCase()).toMatch(/timeout|canceling statement/);
    }, 15000);

    it('enforces a result row limit and reports truncation', async () => {
      env.BACKOFFICE_SQL_RESULT_ROW_LIMIT = 3;
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT * FROM generate_series(1, 10) AS n' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.rows).toHaveLength(3);
      expect(res.body.truncated).toBe(true);
      expect(res.body.rowCount).toBe(10);
    });
  });

  describe('security', () => {
    it('redacts a SECRET-classified column (User.passwordHash) unconditionally', async () => {
      const token = await superAdminToken();
      await registerTestUser(app, { email: `secretcol+${Date.now()}@example.com` });

      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT "passwordHash" FROM users LIMIT 5' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      for (const row of res.body.rows) {
        expect(row.passwordHash).toBe('[REDACTED]');
      }
    });

    it('masks a PII-classified column by default', async () => {
      env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = false;
      const token = await superAdminToken();
      const email = `masked+${Date.now()}@example.com`;
      await registerTestUser(app, { email });

      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: `SELECT email FROM users WHERE email = '${email}'` });
      expect(res.status).toBe(200);
      const row = res.body.rows[0];
      expect(row.email).not.toBe(email);
      expect(row.email).toMatch(/\*{3}/);
    });

    it('only unmasks PII when both the capability and the explicit config switch are set', async () => {
      const token = await superAdminToken();
      const email = `unmasked+${Date.now()}@example.com`;
      await registerTestUser(app, { email });

      env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = false;
      const maskedRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: `SELECT email FROM users WHERE email = '${email}'` });
      expect(maskedRes.body.rows[0].email).not.toBe(email);

      env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = true;
      const unmaskedRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: `SELECT email FROM users WHERE email = '${email}'` });
      expect(unmaskedRes.body.rows[0].email).toBe(email);
    });

    it('fails closed on production execution when raw SQL is not explicitly enabled', async () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_RAW_SQL_ENABLED = false;
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT 1' });
      expect(res.status).toBe(403);
    });

    it('fails closed on production writes when write execution is not explicitly enabled, even with a reason', async () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_RAW_SQL_ENABLED = true;
      env.BACKOFFICE_RAW_SQL_WRITE_ENABLED = false;
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: "UPDATE organisations SET name = 'x' WHERE id = 'nope'",
          reason: 'test',
          confirmationPhrase: 'PRODUCTION',
        });
      expect(res.status).toBe(403);
    });

    it('requires the stronger typed PRODUCTION phrase (not CONFIRM) for a production mutation', async () => {
      env.NODE_ENV = 'production';
      const token = await superAdminToken();
      const res = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: "UPDATE organisations SET name = 'x' WHERE id = 'nope'",
          reason: 'test',
          confirmationPhrase: 'CONFIRM',
        });
      expect(res.status).toBe(422);
    });
  });

  describe('audit', () => {
    it('records a PlatformAuditEvent for a successful SELECT', async () => {
      const token = await superAdminToken();
      await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: 'SELECT 1 AS n' });

      const event = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'sqlConsole.executed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(event).toBeTruthy();
      const after = event?.after as Record<string, unknown>;
      expect(after.success).toBe(true);
      expect(after.statementKind).toBe('SELECT');
    });

    it('requires a reason AND explicit confirmation before a mutating statement executes, and does not audit the rejected attempt', async () => {
      const token = await superAdminToken();

      const noReasonRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: "UPDATE organisations SET name = 'x' WHERE id = 'nope'" });
      expect(noReasonRes.status).toBe(422);

      const noConfirmRes = await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({ sql: "UPDATE organisations SET name = 'x' WHERE id = 'nope'", reason: 'test' });
      expect(noConfirmRes.status).toBe(422);

      const count = await testPrisma.platformAuditEvent.count({
        where: { action: 'sqlConsole.executed' },
      });
      expect(count).toBe(0);
    });

    it('never stores the raw literal value from a mutating statement in audit metadata', async () => {
      const token = await superAdminToken();
      await testPrisma.$executeRawUnsafe(
        'CREATE TABLE sql_console_test_scratch (id serial primary key, email text)',
      );
      const secretLiteral = 'super-sensitive-value@example.com';

      await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: `INSERT INTO sql_console_test_scratch (email) VALUES ('${secretLiteral}')`,
          reason: 'test audit redaction',
          confirmationPhrase: 'CONFIRM',
        });

      const event = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'sqlConsole.executed' },
        orderBy: { createdAt: 'desc' },
      });
      const after = event?.after as Record<string, unknown>;
      expect(JSON.stringify(after)).not.toContain(secretLiteral);
      expect(after.sanitizedQuery).toContain('?');
    });

    it('records a failed execution (a real DB error) without leaking the literal value in audit metadata', async () => {
      const token = await superAdminToken();
      await testPrisma.$executeRawUnsafe(
        'CREATE TABLE sql_console_test_scratch (id serial primary key, email text unique)',
      );
      const secretLiteral = 'duplicate-secret@example.com';
      await testPrisma.$executeRawUnsafe(
        `INSERT INTO sql_console_test_scratch (email) VALUES ('${secretLiteral}')`,
      );

      await request(app)
        .post('/api/v1/backoffice/sql-console/execute')
        .set(authHeader(token))
        .send({
          sql: `INSERT INTO sql_console_test_scratch (email) VALUES ('${secretLiteral}')`,
          reason: 'test duplicate',
          confirmationPhrase: 'CONFIRM',
        });

      const event = await testPrisma.platformAuditEvent.findFirst({
        where: { action: 'sqlConsole.executed' },
        orderBy: { createdAt: 'desc' },
      });
      const after = event?.after as Record<string, unknown>;
      expect(after.success).toBe(false);
      expect(JSON.stringify(after)).not.toContain(secretLiteral);
    });
  });
});
