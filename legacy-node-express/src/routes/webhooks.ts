import { Router } from "express";
import { getStoreByKey } from "../config";
import { verifyShopifyHmac, logInvalidWebhook } from "../shopify/webhook";
import { mapShopifyOrderToCandidate } from "../shopify/mapOrder";
import { upsertPendingCandidate } from "../db/upsertCandidate";
import { logger } from "../lib/logger";
import type { ShopifyOrder } from "../shopify/types";

export const webhooksRouter = Router();

// Raw body is required for HMAC verification; wired via express.raw() on this
// route only (see app.ts). This handler only ever upserts pending_approval —
// it must never enqueue the shipping pipeline, per the "not fully automatic" requirement.
webhooksRouter.post("/shopify/:storeKey/orders-paid", async (req, res) => {
  const store = getStoreByKey(req.params.storeKey);
  if (!store) {
    return res.status(404).json({ error: "unknown_store" });
  }

  const hmacHeader = req.header("X-Shopify-Hmac-Sha256");
  const rawBody = req.body as Buffer;

  if (!verifyShopifyHmac(rawBody, hmacHeader, store.webhookSecret)) {
    logInvalidWebhook("orders/paid");
    return res.status(401).json({ error: "invalid_hmac" });
  }

  let order: ShopifyOrder;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const eventId = req.header("X-Shopify-Webhook-Id") ?? undefined;
  const candidate = mapShopifyOrderToCandidate(order);

  try {
    await upsertPendingCandidate(candidate, store.key, eventId);
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error({ err: error, shopifyOrderId: candidate.shopifyOrderId }, "webhook_processing_failed");
    res.status(500).json({ error: "processing_failed" });
  }
});
