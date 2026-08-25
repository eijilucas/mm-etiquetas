import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import { fetchPaidUnfulfilledOrders, mapShopifyOrderToCandidate } from "./shopify.ts";
import { upsertPendingCandidate } from "./db.ts";
import { sendAlert, runShippingPipeline, TRACKING_NOT_YET_AVAILABLE_ERROR } from "./pipeline.ts";
import { fetchTrackingBatch } from "./melhorenvio.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

// Backfills the candidate queue for paid+unfulfilled orders. Covers webhook
// downtime and the initial backlog of orders paid before this system existed.
// Never enqueues the shipping pipeline directly — only upserts pending_approval.
export async function runReconciliation(
  supabase: SupabaseClient,
  config: AppConfig,
): Promise<{ scanned: number; upserted: number }> {
  log({}, "reconciliation_start");
  let scanned = 0;
  let upserted = 0;
  for (const store of config.shopify.stores) {
    const orders = await fetchPaidUnfulfilledOrders(store);
    let storeUpserted = 0;
    for (const order of orders) {
      const candidate = await mapShopifyOrderToCandidate(order, store);
      await upsertPendingCandidate(supabase, candidate, store.key);
      storeUpserted += 1;
    }
    scanned += orders.length;
    upserted += storeUpserted;
    log({ storeKey: store.key, scanned: orders.length, upserted: storeUpserted }, "reconciliation_store_done");
  }
  log({ scanned, upserted }, "reconciliation_done");
  return { scanned, upserted };
}

// Melhor Envio itself knows when the carrier scanned a package in (see
// MeTrackingEntry.posted_at), so "posted" is synced from there instead of
// relying on the packer to remember to click "Marcar como postado" — that
// button stays only as a manual fallback for whatever this misses.
export async function syncPostedOrders(supabase: SupabaseClient, config: AppConfig): Promise<{ checked: number; posted: number }> {
  const { data: candidates, error } = await supabase
    .from("orders_shipping")
    .select("id, melhor_envio_order_id")
    .is("posted_at", null)
    .not("melhor_envio_order_id", "is", null)
    .not("label_pdf_url", "is", null);
  if (error) throw error;

  const rows = (candidates ?? []) as { id: string; melhor_envio_order_id: string }[];
  if (rows.length === 0) return { checked: 0, posted: 0 };

  const tracking = await fetchTrackingBatch(config, rows.map((row) => row.melhor_envio_order_id));

  let posted = 0;
  for (const row of rows) {
    const entry = tracking[row.melhor_envio_order_id];
    if (!entry?.posted_at) continue;
    const { error: updateError } = await supabase
      .from("orders_shipping")
      .update({ posted_at: entry.posted_at })
      .eq("id", row.id)
      .is("posted_at", null); // don't clobber a manual mark that happened in between
    if (updateError) throw updateError;
    posted += 1;
  }

  log({ checked: rows.length, posted }, "reconciliation_posted_synced");
  return { checked: rows.length, posted };
}

// Melhor Envio often doesn't assign the real tracking code until the
// carrier physically scans the package in, which can be hours after the
// label was bought — syncTrackingStep throws and the order sits in
// "failed" until someone clicks Reprocessar by hand. This retries exactly
// that failure class automatically (only it — every other failure reason,
// e.g. an invalid CEP, needs a human; blindly retrying wouldn't fix those).
export async function retryStalledTracking(
  supabase: SupabaseClient,
  config: AppConfig,
  runPipeline: typeof runShippingPipeline = runShippingPipeline,
): Promise<{ retried: number }> {
  const { data: stalled, error } = await supabase
    .from("orders_shipping")
    .select("id")
    .eq("status", "failed")
    .eq("last_error", TRACKING_NOT_YET_AVAILABLE_ERROR)
    .not("melhor_envio_order_id", "is", null);
  if (error) throw error;

  const rows = (stalled ?? []) as { id: string }[];
  for (const row of rows) {
    await runPipeline(supabase, config, row.id);
  }
  log({ retried: rows.length }, "reconciliation_retried_stalled_tracking");
  return { retried: rows.length };
}

// tracking_ready is included so an order nobody clicked Enviar on eventually
// alerts too, instead of silently sitting there forever unnoticed.
const NON_TERMINAL_STATUSES = ["approved", "cart_created", "purchased", "label_generated", "tracking_ready", "failed"];

// Alerts once per stuck order per scan; relies on updated_at age so a
// reprocess (which touches updated_at) naturally resets the alert window.
export async function checkStuckOrders(supabase: SupabaseClient, config: AppConfig): Promise<void> {
  const threshold = new Date(Date.now() - config.alerts.stuckHours * 60 * 60 * 1000).toISOString();
  const { data: stuck, error } = await supabase
    .from("orders_shipping")
    .select("*")
    .in("status", NON_TERMINAL_STATUSES)
    .lt("updated_at", threshold);
  if (error) throw error;

  for (const order of stuck ?? []) {
    log({ orderShippingId: order.id, status: order.status, level: "warn" }, "order_stuck_alert");
    await sendAlert(
      config,
      `[mm-etiquetas] Pedido ${order.shopify_order_number ?? order.shopify_order_id} travado em "${order.status}" ha mais de ${config.alerts.stuckHours}h. Ultimo erro: ${order.last_error ?? "n/a"}`,
    );
  }
}
