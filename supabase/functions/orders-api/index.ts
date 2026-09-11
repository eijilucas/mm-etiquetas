import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { createServiceClient, toApiShape, upsertExternalCandidate } from "../_shared/db.ts";
import type { OrderShippingRow, ShippingStatus } from "../_shared/db.ts";
import { runShippingPipeline, cancelOrderLabel, manualTrackingSync, checkApprovalIssues } from "../_shared/pipeline.ts";
import { runReconciliation, checkStuckOrders, syncPostedOrders, retryStalledTracking } from "../_shared/reconciliation.ts";
import { fetchAccountBalance, fetchDeclarationPdfUrl, fetchTrackingBatch, fetchOrderConciliationProbe } from "../_shared/melhorenvio.ts";
import { fetchPaidFulfilledOrders, fetchOrderByNumber, mapShopifyOrderToCandidate, latestFulfillmentTracking } from "../_shared/shopify.ts";
import { getStoreByKey } from "../_shared/config.ts";
import { reportExternalStageChangeForIds } from "../_shared/integrationCallback.ts";
import { sleep } from "../_shared/retry.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Espaçamento entre o disparo do pipeline de cada pedido numa aprovação em
// lote. Sem isso, aprovar N pedidos de uma vez manda ~N chamadas de compra
// pra Melhor Envio quase simultâneas (backgroundRun não espera uma acabar
// pra começar a próxima) — foi essa rajada, não coincidência, que fez vários
// pedidos voltarem com "checkout returned an empty response" no mesmo
// instante (ver last_error do dia 2026-09-06). O valor é um chute
// conservador — a Melhor Envio não documenta o limite real de requisições.
// TODO: ajustar pra baixo se confirmarmos (via log de headers de rate limit)
// que dava pra ir mais rápido sem esbarrar no limite deles.
const APPROVE_PIPELINE_STAGGER_MS = 1200;

const PROCESSING_STATUSES: ShippingStatus[] = [
  "approved",
  "cart_created",
  "purchased",
  "label_generated",
  "tracking_ready",
  "tracking_synced",
  "failed",
];

export interface Deps {
  config?: AppConfig;
  supabase?: SupabaseClient;
  runPipeline?: typeof runShippingPipeline;
  cancelOrder?: typeof cancelOrderLabel;
  manualTracking?: typeof manualTrackingSync;
}

// The panel is hosted on a separate static-hosting domain (Supabase Edge
// Functions can't serve rendered HTML on the default *.supabase.co domain —
// see README), so every response needs CORS headers for the browser to
// accept it. Access is already gated by the bearer token, not by origin, so
// a wildcard is fine here.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function routeSegments(req: Request): string[] {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const idx = segments.indexOf("orders-api");
  return idx >= 0 ? segments.slice(idx + 1) : segments;
}

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil(promise: Promise<any>): void } | undefined;

function backgroundRun(promise: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch((err) => console.log(JSON.stringify({ level: "error", err: String(err), msg: "background_pipeline_failed" })));
  }
}


export async function handleOrdersApi(req: Request, deps: Deps = {}): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const config = deps.config ?? loadConfig();
  const segments = routeSegments(req);
  const isReconciliationRun = req.method === "POST" && segments[0] === "reconciliation" && segments[1] === "run";

  // Gateway-level `verify_jwt = true` (see config.toml) already rejects any
  // request without a validly-signed Supabase JWT before this code runs —
  // this just confirms it's a real logged-in user (not just the public
  // anon key) and gives us their email for approved_by/held_by.
  const user = getAuthenticatedUser(req);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = deps.supabase ?? createServiceClient(config);
  const runPipeline = deps.runPipeline ?? runShippingPipeline;
  const cancelOrder = deps.cancelOrder ?? cancelOrderLabel;
  const manualTracking = deps.manualTracking ?? manualTrackingSync;

  try {
    // The KPI row is always visible regardless of which tab is open, so
    // loadAll polls this on every tick — head:true asks Postgrest for just
    // the row count, not the rows, which is what makes that safe to do
    // every minute without re-downloading Fila/Liberados/Postados in full
    // just to display four numbers.
    if (req.method === "GET" && segments[0] === "kpi-counts") {
      const [pending, processing, completed, failed] = await Promise.all([
        supabase.from("orders_shipping").select("*", { count: "exact", head: true }).eq("status", "pending_approval"),
        supabase.from("orders_shipping").select("*", { count: "exact", head: true }).in("status", ["approved", "cart_created", "purchased", "label_generated", "tracking_ready"]),
        supabase.from("orders_shipping").select("*", { count: "exact", head: true }).eq("status", "tracking_synced"),
        supabase.from("orders_shipping").select("*", { count: "exact", head: true }).eq("status", "failed"),
      ]);
      for (const result of [pending, processing, completed, failed]) {
        if (result.error) throw result.error;
      }
      return json({ pending: pending.count ?? 0, processing: processing.count ?? 0, completed: completed.count ?? 0, failed: failed.count ?? 0 });
    }

    if (req.method === "GET" && segments[0] === "pending") {
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("*")
        .eq("status", "pending_approval")
        .order("paid_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    if (req.method === "GET" && segments[0] === "processing") {
      // This list only shrinks via /archive, so it grows without bound over
      // time — trimmed to the columns Liberados/Postados/Rastreio actually
      // render (drops shipping_address, the heaviest jsonb column not shown
      // anywhere here). items is kept: Liberados shows the piece name/variant
      // so whoever's separating the order can match it to the physical item,
      // same as the Fila de aprovação table already does.
      const { data, error } = await supabase
        .from("orders_shipping")
        .select(
          "id, store_key, shopify_order_id, shopify_order_number, customer_name, currency, status, shipping_price, tracking_code, label_pdf_url, last_error, melhor_envio_order_id, paid_at, approved_at, updated_at, posted_at, posted_by, items",
        )
        .in("status", PROCESSING_STATUSES)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    if (req.method === "GET" && segments[0] === "held") {
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("id, store_key, shopify_order_id, shopify_order_number, customer_name, held_reason, held_at")
        .eq("status", "held")
        .order("held_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    // The "Pedidos com erros / removidos" tab: orders that failed (status
    // "failed" — pulled out of Liberados so a broken order never sits next
    // to a healthy one), orders parked in "held" (a Cancelar lands here; the
    // dedicated "Em espera" tab was removed), and orders removed via
    // /archive. One list, most recent activity first. select("*") because
    // this set is small and bounded (unlike /processing), and the per-row
    // actions need the full row.
    if (req.method === "GET" && segments[0] === "archived") {
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("*")
        .in("status", ["failed", "held", "archived"])
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    // Diagnoses "this order is paid on Shopify but missing from every panel
    // tab" (e.g. #3441/#3419, 2026-09) without needing DB/log access: fetches
    // the order live from Shopify by its human-facing number, checks whether
    // any row already exists for it (any status, not just pending_approval —
    // it could be sitting archived/held/external and just look "missing"),
    // and replays the exact same mapping reconciliation/the webhook use so a
    // real mapping failure shows its real error instead of a guess. Never
    // writes anything.
    if (req.method === "GET" && segments[0] === "diagnose-order") {
      const url = new URL(req.url);
      const storeKey = url.searchParams.get("storeKey") ?? "";
      const orderNumber = url.searchParams.get("orderNumber") ?? "";
      const store = getStoreByKey(config, storeKey);
      if (!store) return json({ error: `unknown_store_key: ${storeKey}` }, 400);
      if (!orderNumber) return json({ error: "orderNumber_required" }, 400);

      const shopifyOrder = await fetchOrderByNumber(store, orderNumber);
      if (!shopifyOrder) {
        return json({ foundInShopify: false });
      }

      const { data: existingRows, error: findError } = await supabase
        .from("orders_shipping")
        .select("id, status, last_error, held_reason, archived_by, updated_at")
        .eq("store_key", storeKey)
        .eq("shopify_order_id", String(shopifyOrder.id));
      if (findError) throw findError;

      let mapping: { ok: true } | { ok: false; error: string };
      try {
        await mapShopifyOrderToCandidate(shopifyOrder, store);
        mapping = { ok: true };
      } catch (error) {
        mapping = { ok: false, error: String(error) };
      }

      return json({
        foundInShopify: true,
        shopify: {
          id: shopifyOrder.id,
          orderNumber: shopifyOrder.order_number,
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          lineItemCount: shopifyOrder.line_items?.length ?? null,
        },
        existingRows: existingRows ?? [],
        mapping,
      });
    }

    // TEMPORARY diagnostic route for the shipping-cost-callback "diferenca de
    // frete" investigation (2026-09-10) — returns the raw, undocumented
    // Melhor Envio response for GET /me/orders/search?q=<rastreio>, so we can
    // see where the conference-debit value actually lives before building
    // the real cron. Read-only, same auth as every other route here (a
    // logged-in panel user). Delete this route + fetchOrderConciliationProbe
    // once the cron is implemented.
    if (req.method === "GET" && segments[0] === "me-conciliation-probe") {
      const url = new URL(req.url);
      const trackingCode = url.searchParams.get("trackingCode") ?? "";
      if (!trackingCode) return json({ error: "trackingCode_required" }, 400);
      const raw = await fetchOrderConciliationProbe(config, trackingCode);
      return json({ raw });
    }

    // Read-only history: orders fulfilled entirely outside this system (see
    // shopify-webhook's "external" recording). Nothing here is ever acted
    // on -- no approve/hold/archive route touches this status.
    if (req.method === "GET" && segments[0] === "external") {
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("id, store_key, shopify_order_id, shopify_order_number, customer_name, total_price, currency, tracking_code, tracking_company, paid_at")
        .eq("status", "external")
        .order("paid_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    // One-off backfill for orders fulfilled externally before "external"
    // recording existed, or from any webhook delivery that was missed --
    // walks Shopify's order history directly instead of waiting for the
    // next event on each order. Same upsertExternalCandidate the webhook
    // uses, so it never touches an order already further along in our own
    // pipeline. { days } defaults to 90; pass a bigger window if needed.
    if (req.method === "POST" && segments[0] === "external" && segments[1] === "backfill") {
      const body = (await req.json().catch(() => ({}))) as { days?: number };
      const days = body.days ?? 90;
      const createdAtMin = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      let recorded = 0;
      let skipped = 0;
      for (const store of config.shopify.stores) {
        const orders = await fetchPaidFulfilledOrders(store, { createdAtMin });
        for (const order of orders) {
          const candidate = await mapShopifyOrderToCandidate(order, store);
          const { trackingCode, trackingCompany } = latestFulfillmentTracking(order);
          const row = await upsertExternalCandidate(supabase, candidate, store.key, trackingCode, trackingCompany);
          if (row.status === "external") recorded += 1;
          else skipped += 1;
        }
      }
      return json({ recorded, skipped });
    }

    // Pre-flight for a batch approval: estimates each selected order's
    // cheapest shipping quote (the same /me/shipment/calculate call the
    // real purchase will make) and compares the total against the live
    // wallet balance — so a batch that can't be fully paid for is caught
    // here, before any order is marked approved, instead of Melhor Envio
    // rejecting purchases one by one mid-batch with an unhelpful empty-body
    // 422 (see the balance-exhaustion incident this was built to prevent).
    if (req.method === "POST" && segments[0] === "approve-preview") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json({ error: "ids_required" }, 400);
      }
      const { data: orders, error } = await supabase.from("orders_shipping").select("*").in("id", body.ids);
      if (error) throw error;

      let estimatedTotal = 0;
      let unestimated = 0;
      const problems: { id: string; orderNumber: string | null; blocking: string[]; warnings: string[] }[] = [];
      for (const order of (orders ?? []) as OrderShippingRow[]) {
        const { price, blocking, warnings } = await checkApprovalIssues(config, order);
        if (price == null) unestimated += 1;
        else estimatedTotal += price;
        if (blocking.length > 0 || warnings.length > 0) {
          problems.push({ id: order.id, orderNumber: order.shopify_order_number, blocking, warnings });
        }
      }

      const balance = await fetchAccountBalance(config);
      const sufficient = balance == null ? null : balance >= estimatedTotal;
      return json({ estimatedTotal, unestimated, balance, sufficient, problems });
    }

    if (req.method === "POST" && segments[0] === "approve") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json({ error: "ids_required" }, 400);
      }

      const results: { id: string; ok: boolean; error?: string }[] = [];
      let pipelinesStarted = 0;
      for (const id of body.ids) {
        const { data: order, error: findError } = await supabase
          .from("orders_shipping")
          .select("*")
          .eq("id", id)
          .single();
        if (findError || !order) {
          results.push({ id, ok: false, error: "internal_error" });
          continue;
        }
        if (order.status !== "pending_approval") {
          results.push({ id, ok: false, error: `order status is ${order.status}, not pending_approval` });
          continue;
        }
        const { error: updateError } = await supabase
          .from("orders_shipping")
          .update({ status: "approved", approved_by: user.email, approved_at: new Date().toISOString() })
          .eq("id", id);
        if (updateError) {
          results.push({ id, ok: false, error: "internal_error" });
          continue;
        }
        // approve is one of only two routes allowed to run the shipping
        // pipeline. It runs after the status write so the caller's response
        // (below) returns immediately, matching the old "enqueue and return" UX.
        // Escalonado (ver APPROVE_PIPELINE_STAGGER_MS) pra não disparar um
        // lote inteiro de compras na Melhor Envio no mesmo instante.
        const delayMs = pipelinesStarted * APPROVE_PIPELINE_STAGGER_MS;
        pipelinesStarted += 1;
        backgroundRun(
          (async () => {
            if (delayMs > 0) await sleep(delayMs);
            await runPipeline(supabase, config, id);
          })(),
        );
        results.push({ id, ok: true });
      }
      return json({ results });
    }

    if (req.method === "POST" && segments[0] === "hold") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[]; reason?: string };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json({ error: "ids_required" }, 400);
      }
      if (!body.reason) {
        return json({ error: "reason_required" }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: "held", held_reason: body.reason, held_by: user.email, held_at: new Date().toISOString() })
        .in("id", body.ids)
        .eq("status", "pending_approval");
      if (error) throw error;
      await reportExternalStageChangeForIds(supabase, config, body.ids);
      return json({ ok: true });
    }

    // Marks orders as physically dropped off at the carrier's collection
    // point — separate from the shipping_status lifecycle (see migration
    // 0003), so this only ever touches posted_at/posted_by.
    if (req.method === "POST" && segments[0] === "post") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json({ error: "ids_required" }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ posted_at: new Date().toISOString(), posted_by: user.email })
        .in("id", body.ids)
        .in("status", PROCESSING_STATUSES);
      if (error) throw error;
      await reportExternalStageChangeForIds(supabase, config, body.ids);
      return json({ ok: true });
    }

    // Read-only preview: batch-fetches from Melhor Envio, per order id, both
    // (a) whatever tracking code ME already has (Rastreio tab / Liberados
    // send button — same fallback as syncTrackingStep) and (b) ME's own
    // order protocol + created_at, which is what the Liberados tab sorts by
    // so its row order matches Melhor Envio's own "Pedidos" list exactly.
    if (req.method === "POST" && segments[0] === "tracking-preview") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) return json({ previews: {}, meta: {} });
      const { data: orders, error } = await supabase
        .from("orders_shipping")
        .select("id, melhor_envio_order_id")
        .in("id", body.ids)
        .not("melhor_envio_order_id", "is", null);
      if (error) throw error;
      const rows = (orders ?? []) as { id: string; melhor_envio_order_id: string }[];
      const tracking = await fetchTrackingBatch(config, rows.map((row) => row.melhor_envio_order_id));
      const previews: Record<string, string | null> = {};
      const meta: Record<string, { protocol: string | null; createdAt: string | null }> = {};
      for (const row of rows) {
        const entry = tracking[row.melhor_envio_order_id];
        previews[row.id] = entry?.tracking || entry?.melhorenvio_tracking || null;
        meta[row.id] = { protocol: entry?.protocol ?? null, createdAt: entry?.created_at ?? null };
      }
      return json({ previews, meta });
    }

    // Explicit manual reversal is the only way a held order re-enters pending_approval.
    if (req.method === "POST" && segments[0] === "revert") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json({ error: "ids_required" }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: "pending_approval", held_reason: null, held_by: null, held_at: null })
        .in("id", body.ids)
        .eq("status", "held");
      if (error) throw error;
      await reportExternalStageChangeForIds(supabase, config, body.ids);
      return json({ ok: true });
    }

    // Same four steps reconciliation-cron runs on its own schedule, exposed
    // here so a person can trigger a full catch-up on demand. Order matters:
    // the cheap, high-value steps (sync posted status, retry stalled
    // tracking, stuck alerts) run FIRST and each in its own try/catch, so
    // the slow one — runReconciliation, one Shopify GraphQL call per
    // paid+unfulfilled order — can't time the whole request out before they
    // get a turn (which is exactly why "Sincronizar agora" wasn't moving
    // orders to Postados).
    if (req.method === "POST" && isReconciliationRun) {
      const step = async (label: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          console.log(JSON.stringify({ level: "error", step: label, err: String(error), msg: "reconciliation_run_step_failed" }));
        }
      };
      await step("syncPostedOrders", () => syncPostedOrders(supabase, config));
      await step("retryStalledTracking", () => retryStalledTracking(supabase, config));
      await step("checkStuckOrders", () => checkStuckOrders(supabase, config));
      let result: unknown = { scanned: 0, upserted: 0 };
      await step("runReconciliation", async () => {
        result = await runReconciliation(supabase, config);
      });
      return json(result);
    }

    // Reprocess a failed (or partially processed) order without duplicating
    // already-completed external steps — the pipeline itself is idempotent per status.
    if (req.method === "POST" && segments[1] === "reprocess") {
      const id = segments[0];
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      if (order.status === "pending_approval" || order.status === "held") {
        return json({ error: `cannot reprocess order in status ${order.status}` }, 400);
      }
      const { error: updateError } = await supabase.from("orders_shipping").update({ last_error: null }).eq("id", order.id);
      if (updateError) throw updateError;
      // reprocess is the other route allowed to run the shipping pipeline.
      backgroundRun(runPipeline(supabase, config, order.id));
      return json({ ok: true });
    }

    // Sends a FAILED order back to the approval queue so a person can
    // re-check it (fix the customer's address, hold it, ...) instead of
    // blindly reprocessing as-is. Refused once shipping was bought on Melhor
    // Envio — that money would be stranded; Cancelar (refund + park in held)
    // first.
    if (req.method === "POST" && segments[1] === "back-to-queue") {
      const id = segments[0];
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      if (order.status !== "failed") {
        return json({ error: `cannot send order in status ${order.status} back to the queue` }, 400);
      }
      if (order.melhor_envio_order_id) {
        return json({ error: "Esse pedido ja comprou frete na Melhor Envio — use Cancelar (estorna e coloca em espera) antes." }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: "pending_approval", last_error: null })
        .eq("id", id);
      if (error) throw error;
      await reportExternalStageChangeForIds(supabase, config, [id]);
      return json({ ok: true });
    }

    // Undoes an already-purchased label: cancels the shipment at Melhor
    // Envio (refunds the wallet) and parks the order in "held" so it needs
    // an explicit human decision (revert + re-approve, or leave it) instead
    // of silently re-entering the pipeline.
    if (req.method === "POST" && segments[1] === "cancel") {
      const id = segments[0];
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      if (!body.reason) return json({ error: "reason_required" }, 400);
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      if (!PROCESSING_STATUSES.includes(order.status)) {
        return json({ error: `cannot cancel order in status ${order.status}` }, 400);
      }
      await cancelOrder(supabase, config, id, body.reason);
      return json({ ok: true });
    }

    // Permanently dismisses an order from every panel tab without deleting
    // the row (who held it, why, when stays in the DB) — for orders handled
    // entirely outside this system that don't belong in any queue anymore
    // (e.g. #3290, a label bought by hand on Melhor Envio's own site — or a
    // batch that failed here and got fulfilled by hand on Shopify directly,
    // tracking code and all). Allowed only from statuses with no automated
    // next step waiting on the order: "held", "failed", and "tracking_ready"
    // (the tracking code was fetched but sending it to Shopify is a manual
    // click that nothing does on its own) — so an order still actively
    // mid-pipeline can't be dismissed.
    if (req.method === "POST" && segments[1] === "archive") {
      const id = segments[0];
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      // "external" included so a "Processados por fora" row can be removed
      // from the panel too (it has no automated next step waiting on it).
      const archivable = ["held", "failed", "tracking_ready", "external"];
      if (!archivable.includes(order.status)) {
        return json({ error: `cannot archive order in status ${order.status}` }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: "archived", archived_at: new Date().toISOString(), archived_by: user.email })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    // Undo an /archive. There's no stored "status before archiving" column
    // (would need a migration), so this infers it from fields /archive never
    // touches:
    //  - held_at set                        -> was "held"   (only /hold sets it)
    //  - melhor_envio_order_id + tracking_code -> "tracking_ready" (real
    //    tracking_ready always has both)
    //  - tracking_code but NO ME order id   -> "external" (a Vendas Externas
    //    order carries a Shopify-fulfillment tracking code, never a ME order)
    //  - otherwise                          -> "failed"
    // Edge: an external order archived with no tracking code at all restores
    // as "failed" — rare, and harmless (shows in the erros/removidos tab).
    if (req.method === "POST" && segments[1] === "restore") {
      const id = segments[0];
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      if (order.status !== "archived") {
        return json({ error: `cannot restore order in status ${order.status}` }, 400);
      }
      const restoredStatus: ShippingStatus = order.held_at
        ? "held"
        : order.melhor_envio_order_id && order.tracking_code
          ? "tracking_ready"
          : order.tracking_code
            ? "external"
            : "failed";
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: restoredStatus, archived_at: null, archived_by: null })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true, status: restoredStatus });
    }

    // For a shipment purchased entirely outside this system (e.g. the CEP
    // our pipeline rejected, so it got bought by hand on Melhor Envio's
    // site) — hands a manually-typed tracking code straight to Shopify.
    // Errors are surfaced with their real message (not the generic 500 the
    // outer catch below returns) since a human is acting on this directly.
    if (req.method === "POST" && segments[1] === "tracking") {
      const id = segments[0];
      const body = (await req.json().catch(() => ({}))) as { trackingCode?: string };
      const trackingCode = body.trackingCode?.trim();
      if (!trackingCode) return json({ error: "tracking_code_required" }, 400);
      try {
        await manualTracking(supabase, config, id, trackingCode);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "internal_error" }, 400);
      }
      return json({ ok: true });
    }

    // The content-declaration PDF link is short-lived (~30min pre-signed S3
    // URL), so it's fetched live on demand rather than stored like the label.
    if (req.method === "GET" && segments[1] === "declaration") {
      const { data: order, error } = await supabase.from("orders_shipping").select("*").eq("id", segments[0]).single();
      if (error || !order) return json({ error: "not_found" }, 404);
      if (!order.melhor_envio_order_id) return json({ error: "no_melhor_envio_order_yet" }, 400);
      const url = await fetchDeclarationPdfUrl(config, order.melhor_envio_order_id);
      return json({ url });
    }

    if (req.method === "GET" && segments.length === 1 && segments[0]) {
      const { data: order, error } = await supabase.from("orders_shipping").select("*").eq("id", segments[0]).single();
      if (error || !order) return json({ error: "not_found" }, 404);
      return json({ order: toApiShape(order as OrderShippingRow) });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    console.log(JSON.stringify({ level: "error", err: String(error), msg: "orders_api_request_failed" }));
    return json({ error: "internal_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleOrdersApi(req));
}
