-- CreateEnum
CREATE TYPE "StrataStatus" AS ENUM ('NOT_ENABLED', 'SETUP_IN_PROGRESS', 'ACTIVE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_ENABLED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_CONFIGURED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_ENTITLEMENTS_UPDATED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_SETUP_COMPLETED';

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "strataPlanDeclaredUnitsOfEntitlement" DECIMAL(12,2),
ADD COLUMN     "strataStatus" "StrataStatus" NOT NULL DEFAULT 'NOT_ENABLED';
