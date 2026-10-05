-- AlterTable
ALTER TABLE "communications" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "maintenance_requests" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "quote_rounds" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "work_order_variations" ADD COLUMN     "publicReference" TEXT;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "publicReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "communications_publicReference_key" ON "communications"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_requests_publicReference_key" ON "maintenance_requests"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "properties_publicReference_key" ON "properties"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "quote_rounds_publicReference_key" ON "quote_rounds"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_publicReference_key" ON "spaces"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_variations_publicReference_key" ON "work_order_variations"("publicReference");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_publicReference_key" ON "work_orders"("publicReference");

