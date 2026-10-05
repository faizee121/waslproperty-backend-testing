/**
 * One-time (but safely repeatable) backfill of Property.publicReference
 * and the other 6 models' publicReference columns, for rows that existed
 * before the Public Reference system shipped (migration
 * 20261004090355_add_public_references). This is NOT demo seed data — it
 * operates on real existing records and must never be confused with
 * prisma/seed.ts.
 *
 * Safe to run multiple times:
 *   - only touches rows where publicReference IS NULL
 *   - never regenerates or modifies an already-set reference
 *   - never touches any other column (name, code, relationships, etc.)
 *   - collision-safe (see src/lib/public-reference.ts's withPublicReference)
 *
 * Usage:
 *   pnpm prisma:backfill-public-references
 *
 * Same command for local and staging — point DATABASE_URL at the target
 * database (via the environment's own .env, exactly like every other
 * prisma: script in this repo). No production environment exists yet; this
 * is written to be safe to run there unchanged once one does.
 */
import { PrismaClient } from '@prisma/client';
import { withPublicReference } from '../src/lib/public-reference.js';

const prisma = new PrismaClient();

interface BackfillTarget {
  label: string;
  prefix: string;
  findMissing: () => Promise<{ id: string }[]>;
  setReference: (id: string, publicReference: string) => Promise<unknown>;
}

/** Raw SQL, not Prisma's ORM filter — `publicReference` is a NOT NULL
 * column in the CURRENT schema (migration 20261004092405), so Prisma's
 * generated client now rejects `{ publicReference: null }` as an invalid
 * filter for this field at the argument-validation layer, before a query
 * is even built; it would reject it identically for every one of these 7
 * tables even though the column may still genuinely contain NULLs in a
 * database this migration hasn't successfully applied to yet (its own
 * precondition for being able to apply: this backfill has already run).
 * See test/integration/public-references.test.ts's identical fix for the
 * one test that hit this same wall, and strata.service.ts's doc comment
 * on the parallel case this kept failing to apply. */
function findMissingRaw(table: string): () => Promise<{ id: string }[]> {
  return () =>
    prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "${table}" WHERE "publicReference" IS NULL`,
    );
}

const targets: BackfillTarget[] = [
  {
    label: 'Property',
    prefix: 'PROP',
    findMissing: findMissingRaw('properties'),
    setReference: (id, publicReference) =>
      prisma.property.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'Space',
    prefix: 'LOT',
    findMissing: findMissingRaw('spaces'),
    setReference: (id, publicReference) =>
      prisma.space.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'MaintenanceRequest',
    prefix: 'MR',
    findMissing: findMissingRaw('maintenance_requests'),
    setReference: (id, publicReference) =>
      prisma.maintenanceRequest.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'WorkOrder',
    prefix: 'WO',
    findMissing: findMissingRaw('work_orders'),
    setReference: (id, publicReference) =>
      prisma.workOrder.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'QuoteRound',
    prefix: 'RFQ',
    findMissing: findMissingRaw('quote_rounds'),
    setReference: (id, publicReference) =>
      prisma.quoteRound.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'WorkOrderVariation',
    prefix: 'VAR',
    findMissing: findMissingRaw('work_order_variations'),
    setReference: (id, publicReference) =>
      prisma.workOrderVariation.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'Communication',
    prefix: 'COM',
    findMissing: findMissingRaw('communications'),
    setReference: (id, publicReference) =>
      prisma.communication.update({ where: { id }, data: { publicReference } }),
  },
];

async function main() {
  console.log('Public Reference backfill — starting\n');

  const counts: Record<string, number> = {};

  for (const target of targets) {
    const missing = await target.findMissing();
    let updated = 0;
    for (const row of missing) {
      await withPublicReference(target.prefix, (publicReference) =>
        target.setReference(row.id, publicReference),
      );
      updated++;
    }
    counts[target.label] = updated;
    console.log(`${target.label}: ${updated} row(s) updated (prefix ${target.prefix}-)`);
  }

  console.log('\nBackfill complete.');
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
