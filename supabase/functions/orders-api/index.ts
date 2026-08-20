import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { createServiceClient, toApiShape } from "../_shared/db.ts";
import type { OrderShippingRow, ShippingStatus } from "../_shared/db.ts";
import { runShippingPipeline, cancelOrderLabel } from "../_shared/pipeline.ts";
import { runReconciliation } from "../_shared/reconciliation.ts";
import { fetchDeclarationPdfUrl } from "../_shared/melhorenvio.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const PROCESSING_STATUSES: ShippingStatus[] = [
  "approved",
  "cart_created",
  "purchased",
  "label_generated",
  "tracking_synced",
  "failed",
];

export interface Deps {
  config?: AppConfig;
  supabase?: SupabaseClient;
  runPipeline?: typeof runShippingPipeline;
  cancelOrder?: typeof cancelOrderLabel;
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
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("*")
        .in("status", PROCESSING_STATUSES)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
    }

    if (req.method === "GET" && segments[0] === "held") {
      const { data, error } = await supabase
        .from("orders_shipping")
        .select("*")
        .eq("status", "held")
        .order("held_at", { ascending: false });
      if (error) throw error;
      return json({ orders: (data as OrderShippingRow[]).map(toApiShape) });
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
        .in("id", body.ids);
      if (error) throw error;
      return json({ ok: true });
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

    if (req.method === "POST" && isReconciliationRun) {
      const result = await runReconciliation(supabase, config);
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
