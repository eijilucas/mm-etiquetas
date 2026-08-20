-- DropIndex
DROP INDEX "orders_shipping_shopifyOrderId_key";

-- AlterTable
ALTER TABLE "orders_shipping" ADD COLUMN     "storeKey" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "orders_shipping_storeKey_idx" ON "orders_shipping"("storeKey");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shipping_storeKey_shopifyOrderId_key" ON "orders_shipping"("storeKey", "shopifyOrderId");

