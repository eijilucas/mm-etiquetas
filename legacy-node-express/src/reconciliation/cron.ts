import cron from "node-cron";
import { config } from "../config";
import { logger } from "../lib/logger";
import { fetchPaidUnfulfilledOrders } from "../shopify/client";
import { mapShopifyOrderToCandidate } from "../shopify/mapOrder";
import { upsertPendingCandidate } from "../db/upsertCandidate";
import { checkStuckOrders } from "./stuckAlerts";

// Backfills the candidate queue for paid+unfulfilled orders. Covers webhook
// downtime and the initial backlog of orders paid before this system existed.
// Never enqueues the shipping pipeline directly — only upserts pending_approval.
export async function runReconciliation(): Promise<{ scanned: number; upserted: number }> {
  logger.info("reconciliation_start");
  let scanned = 0;
  let upserted = 0;
  for (const store of config.shopify.stores) {
    const orders = await fetchPaidUnfulfilledOrders(store);
    let storeUpserted = 0;
    for (const order of orders) {
      const candidate = mapShopifyOrderToCandidate(order);
      await upsertPendingCandidate(candidate, store.key);
      storeUpserted += 1;
    }
    scanned += orders.length;
    upserted += storeUpserted;
    logger.info(
      { storeKey: store.key, scanned: orders.length, upserted: storeUpserted },
      "reconciliation_store_done",
    );
  }
  logger.info({ scanned, upserted }, "reconciliation_done");
  return { scanned, upserted };
}

export function startReconciliationCron(): void {
  cron.schedule(config.reconciliation.cron, () => {
    runReconciliation().catch((error) => {
      logger.error({ err: error }, "reconciliation_failed");
    });
    checkStuckOrders().catch((error) => {
      logger.error({ err: error }, "stuck_alert_check_failed");
    });
  });
  logger.info({ cron: config.reconciliation.cron }, "reconciliation_cron_scheduled");
}
