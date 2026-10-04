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

const targets: BackfillTarget[] = [
  {
    label: 'Property',
    prefix: 'PROP',
    findMissing: () =>
      prisma.property.findMany({ where: { publicReference: null }, select: { id: true } }),
    setReference: (id, publicReference) =>
      prisma.property.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'Space',
    prefix: 'LOT',
    findMissing: () =>
      prisma.space.findMany({ where: { publicReference: null }, select: { id: true } }),
    setReference: (id, publicReference) =>
      prisma.space.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'MaintenanceRequest',
    prefix: 'MR',
    findMissing: () =>
      prisma.maintenanceRequest.findMany({
        where: { publicReference: null },
        select: { id: true },
      }),
    setReference: (id, publicReference) =>
      prisma.maintenanceRequest.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'WorkOrder',
    prefix: 'WO',
    findMissing: () =>
      prisma.workOrder.findMany({ where: { publicReference: null }, select: { id: true } }),
    setReference: (id, publicReference) =>
      prisma.workOrder.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'QuoteRound',
    prefix: 'RFQ',
    findMissing: () =>
      prisma.quoteRound.findMany({ where: { publicReference: null }, select: { id: true } }),
    setReference: (id, publicReference) =>
      prisma.quoteRound.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'WorkOrderVariation',
    prefix: 'VAR',
    findMissing: () =>
      prisma.workOrderVariation.findMany({
        where: { publicReference: null },
        select: { id: true },
      }),
    setReference: (id, publicReference) =>
      prisma.workOrderVariation.update({ where: { id }, data: { publicReference } }),
  },
  {
    label: 'Communication',
    prefix: 'COM',
    findMissing: () =>
      prisma.communication.findMany({ where: { publicReference: null }, select: { id: true } }),
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
