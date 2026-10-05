-- AlterTable
ALTER TABLE "communications" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "maintenance_requests" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "properties" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "quote_rounds" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "spaces" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "work_order_variations" ALTER COLUMN "publicReference" SET NOT NULL;

-- AlterTable
ALTER TABLE "work_orders" ALTER COLUMN "publicReference" SET NOT NULL;

