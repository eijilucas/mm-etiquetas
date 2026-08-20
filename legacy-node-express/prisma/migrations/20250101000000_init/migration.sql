-- CreateEnum
CREATE TYPE "ShippingStatus" AS ENUM ('pending_approval', 'approved', 'cart_created', 'purchased', 'label_generated', 'tracking_synced', 'held', 'failed');

-- CreateTable
CREATE TABLE "orders_shipping" (
    "id" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT,
    "shopifyGraphqlId" TEXT,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "shippingAddress" JSONB NOT NULL,
    "status" "ShippingStatus" NOT NULL DEFAULT 'pending_approval',
    "lastError" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "heldReason" TEXT,
    "heldBy" TEXT,
    "heldAt" TIMESTAMP(3),
    "melhorEnvioCartId" TEXT,
    "melhorEnvioOrderId" TEXT,
    "melhorEnvioLabelId" TEXT,
    "melhorEnvioProtocol" TEXT,
    "trackingCode" TEXT,
    "trackingCompany" TEXT DEFAULT 'Melhor Envio',
    "labelPdfUrl" TEXT,
    "shopifyFulfillmentId" TEXT,
    "webhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_shipping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_shipping_shopifyOrderId_key" ON "orders_shipping"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "orders_shipping_status_idx" ON "orders_shipping"("status");

-- CreateIndex
CREATE INDEX "orders_shipping_createdAt_idx" ON "orders_shipping"("createdAt");

