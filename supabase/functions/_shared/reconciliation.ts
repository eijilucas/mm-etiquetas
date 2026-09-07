import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import { fetchPaidUnfulfilledOrders, mapShopifyOrderToCandidate } from "./shopify.ts";
import { upsertPendingCandidate } from "./db.ts";
import { sendAlert, runShippingPipeline, TRACKING_NOT_YET_AVAILABLE_ERROR } from "./pipeline.ts";
import { fetchTrackingBatch, POSTED_ME_STATUSES } from "./melhorenvio.ts";
import { reportExternalStageChangeForIds } from "./integrationCallback.ts";
import { sleep } from "./retry.ts";

// Mesmo motivo do stagger em orders-api/index.ts (approve em lote): mesmo
// sendo sequencial (await), zero intervalo entre pedidos ainda vira uma
// rajada de chamadas de compra pra Melhor Envio quando tem vários pedidos
// travados no mesmo tick do cron.
const RETRY_STALLED_STAGGER_MS = 1200;

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
    let storeFailed = 0;
    for (const order of orders) {
      // Per-order guard: a single order that can't be mapped (bad/edited
      // data, a transient Shopify error mid-run) must not abort the rest of
      // the store's batch — that used to silently strip every order after it
      // from the queue until the offending one was handled by hand.
      try {
        const candidate = await mapShopifyOrderToCandidate(order, store);
        await upsertPendingCandidate(supabase, candidate, store.key);
        storeUpserted += 1;
      } catch (error) {
        storeFailed += 1;
        log(
          { storeKey: store.key, shopifyOrderId: order.id, shopifyOrderNumber: order.order_number, err: String(error), level: "error" },
          "reconciliation_order_failed",
        );
      }
    }
    scanned += orders.length;
    upserted += storeUpserted;
    log({ storeKey: store.key, scanned: orders.length, upserted: storeUpserted, failed: storeFailed }, "reconciliation_store_done");
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
  const postedIds: string[] = [];
  for (const row of rows) {
    const entry = tracking[row.melhor_envio_order_id];
    if (!entry) continue;
    // ME shows the order as postado once it's past "released" — but it
    // frequently leaves posted_at null even at status "received"/"delivered"
    // (confirmed live). Trust the status, and fall back to generated_at for
    // the timestamp when there's no posted_at to use.
    const isPosted = !!entry.posted_at || POSTED_ME_STATUSES.has(entry.status ?? "");
    if (!isPosted) continue;
    const postedAt = entry.posted_at || entry.generated_at || new Date().toISOString();
    const { error: updateError } = await supabase
      .from("orders_shipping")
      .update({ posted_at: postedAt })
      .eq("id", row.id)
      .is("posted_at", null); // don't clobber a manual mark that happened in between
    if (updateError) throw updateError;
    posted += 1;
    postedIds.push(row.id);
  }

  // Único posted_at set fora do pipeline e das rotas de orders-api (/post)
  // — avisa o Vendas Externas aqui também, senão a aba Postados de lá nunca
  // reflete o caso mais comum (Melhor Envio detectando o posted sozinho).
  await reportExternalStageChangeForIds(supabase, config, postedIds);

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
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await sleep(RETRY_STALLED_STAGGER_MS);
    await runPipeline(supabase, config, rows[i].id);
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
