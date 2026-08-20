import { prisma } from "./prisma";
import { logger } from "../lib/logger";
import type { OrderCandidate } from "../shopify/mapOrder";

// Both the webhook and the reconciliation cron call this. It only ever
// creates/updates a row as pending_approval — it never enqueues the shipping
// pipeline. That happens exclusively through the manual approval endpoint.
export async function upsertPendingCandidate(
  candidate: OrderCandidate,
  storeKey: string,
  webhookEventId?: string,
) {
  const existing = await prisma.orderShipping.findUnique({
    where: { storeKey_shopifyOrderId: { storeKey, shopifyOrderId: candidate.shopifyOrderId } },
  });

  if (existing && existing.status === "held") {
    logger.info(
      { storeKey, shopifyOrderId: candidate.shopifyOrderId },
      "candidate_skipped_held_order_stays_out_of_queue",
    );
    return existing;
  }

  if (existing && existing.status !== "pending_approval") {
    logger.debug(
      { storeKey, shopifyOrderId: candidate.shopifyOrderId, status: existing.status },
      "candidate_skipped_already_in_pipeline",
    );
    return existing;
  }

  const row = await prisma.orderShipping.upsert({
    where: { storeKey_shopifyOrderId: { storeKey, shopifyOrderId: candidate.shopifyOrderId } },
    create: {
      storeKey,
      shopifyOrderId: candidate.shopifyOrderId,
      shopifyOrderNumber: candidate.shopifyOrderNumber,
      shopifyGraphqlId: candidate.shopifyGraphqlId,
      financialStatus: candidate.financialStatus,
      fulfillmentStatus: candidate.fulfillmentStatus,
      customerName: candidate.customerName,
      customerEmail: candidate.customerEmail,
      currency: candidate.currency,
      totalPrice: candidate.totalPrice,
      paidAt: candidate.paidAt,
      items: candidate.items as unknown as object,
      shippingAddress: (candidate.shippingAddress ?? {}) as unknown as object,
      status: "pending_approval",
      webhookEventId: webhookEventId ?? null,
    },
    update: {
      financialStatus: candidate.financialStatus,
      fulfillmentStatus: candidate.fulfillmentStatus,
      customerName: candidate.customerName,
      customerEmail: candidate.customerEmail,
      totalPrice: candidate.totalPrice,
      paidAt: candidate.paidAt,
      items: candidate.items as unknown as object,
      shippingAddress: (candidate.shippingAddress ?? {}) as unknown as object,
      webhookEventId: webhookEventId ?? undefined,
    },
  });

  logger.info(
    { storeKey, shopifyOrderId: candidate.shopifyOrderId, created: !existing },
    "candidate_upserted_pending_approval",
  );
  return row;
}
