-- CreateEnum
CREATE TYPE "SpaceStrataClassification" AS ENUM ('UNCLASSIFIED', 'LOT', 'COMMON_PROPERTY');

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "strataClassification" "SpaceStrataClassification" NOT NULL DEFAULT 'UNCLASSIFIED';

-- Backfill: any existing M11-A/M11-B row already marked isStrataLot=true
-- was, by definition, a Lot — classify it explicitly rather than leaving
-- it isStrataLot=true + strataClassification=UNCLASSIFIED, a contradiction
-- under the M11-B.1 invariant these two fields must never diverge.
UPDATE "spaces" SET "strataClassification" = 'LOT' WHERE "isStrataLot" = true;
