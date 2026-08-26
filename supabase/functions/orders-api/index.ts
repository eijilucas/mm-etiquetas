import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { createServiceClient, toApiShape } from "../_shared/db.ts";
import type { OrderShippingRow, ShippingStatus } from "../_shared/db.ts";
import { runShippingPipeline, cancelOrderLabel, manualTrackingSync, checkApprovalIssues } from "../_shared/pipeline.ts";
import { runReconciliation, checkStuckOrders, syncPostedOrders, retryStalledTracking } from "../_shared/reconciliation.ts";
import { fetchAccountBalance, fetchDeclarationPdfUrl, fetchTrackingBatch } from "../_shared/melhorenvio.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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
      // render (drops items/shipping_address, the two heaviest jsonb columns).
      const { data, error } = await supabase
        .from("orders_shipping")
        .select(
          "id, store_key, shopify_order_id, shopify_order_number, customer_name, currency, status, shipping_price, tracking_code, label_pdf_url, last_error, melhor_envio_order_id, updated_at, posted_at, posted_by",
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
        backgroundRun(runPipeline(supabase, config, id));
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
      return json({ ok: true });
    }

    // Read-only preview for the Rastreio manual tab: batch-fetches whatever
    // tracking code Melhor Envio already has for each order (same fallback
    // as syncTrackingStep — see melhorenvio.ts) so the packer can just hit
    // Enviar instead of typing the code in by hand.
    if (req.method === "POST" && segments[0] === "tracking-preview") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0) return json({ previews: {} });
      const { data: orders, error } = await supabase
        .from("orders_shipping")
        .select("id, melhor_envio_order_id")
        .in("id", body.ids)
        .not("melhor_envio_order_id", "is", null);
      if (error) throw error;
      const rows = (orders ?? []) as { id: string; melhor_envio_order_id: string }[];
      const tracking = await fetchTrackingBatch(config, rows.map((row) => row.melhor_envio_order_id));
      const previews: Record<string, string | null> = {};
      for (const row of rows) {
        const entry = tracking[row.melhor_envio_order_id];
        previews[row.id] = entry?.tracking || entry?.melhorenvio_tracking || null;
      }
      return json({ previews });
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
      return json({ ok: true });
    }

    // Same four steps reconciliation-cron runs on its own schedule, exposed
    // here so a person can trigger a full catch-up on demand (e.g. to check
    // for a tracking code right now instead of waiting for the next tick).
    if (req.method === "POST" && isReconciliationRun) {
      const result = await runReconciliation(supabase, config);
      await checkStuckOrders(supabase, config);
      await syncPostedOrders(supabase, config);
      await retryStalledTracking(supabase, config);
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

    // Permanently dismisses a held order from every panel tab without
    // deleting the row (who held it, why, when stays in the DB) — for
    // orders handled entirely outside this system that don't belong in any
    // queue anymore (e.g. #3290, a label bought by hand on Melhor Envio's
    // own site — or a batch that failed here and got fulfilled by hand on
    // Shopify directly, tracking code and all). Only from "held" or
    // "failed" — the two places with no automated next step waiting on the
    // order — so an order still actively mid-pipeline can't be dismissed.
    if (req.method === "POST" && segments[1] === "archive") {
      const id = segments[0];
      const { data: order, error: findError } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
      if (findError || !order) return json({ error: "not_found" }, 404);
      if (order.status !== "held" && order.status !== "failed") {
        return json({ error: `cannot archive order in status ${order.status}` }, 400);
      }
      const { error } = await supabase
        .from("orders_shipping")
        .update({ status: "archived", archived_at: new Date().toISOString(), archived_by: user.email })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true });
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
