import { loadConfig, getStoreByKey } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { verifyShopifyHmac, logInvalidWebhook, mapShopifyOrderToCandidate } from "../_shared/shopify.ts";
import type { ShopifyOrder } from "../_shared/shopify.ts";
import { createServiceClient, upsertPendingCandidate } from "../_shared/db.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface Deps {
  config?: AppConfig;
  supabase?: SupabaseClient;
}

// Route: /functions/v1/shopify-webhook/<storeKey>
// This handler only ever upserts pending_approval — it must never enqueue
// the shipping pipeline, per the "not fully automatic" requirement.
export async function handleShopifyWebhook(req: Request, deps: Deps = {}): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  }

  const config = deps.config ?? loadConfig();
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // segments look like ["functions", "v1", "shopify-webhook", "<storeKey>"] locally,
  // or ["shopify-webhook", "<storeKey>"] once deployed behind the functions gateway.
  const storeKey = segments[segments.length - 1];

  const store = getStoreByKey(config, storeKey ?? "");
  if (!store) {
    return new Response(JSON.stringify({ error: "unknown_store" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256");
  const rawBody = new Uint8Array(await req.arrayBuffer());

  const valid = await verifyShopifyHmac(rawBody, hmacHeader, store.webhookSecret);
  if (!valid) {
    logInvalidWebhook("orders/paid");
    return new Response(JSON.stringify({ error: "invalid_hmac" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let order: ShopifyOrder;
  try {
    order = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventId = req.headers.get("X-Shopify-Webhook-Id") ?? undefined;
  const candidate = mapShopifyOrderToCandidate(order);
  const supabase = deps.supabase ?? createServiceClient(config);

  try {
    await upsertPendingCandidate(supabase, candidate, store.key, eventId);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.log(
      JSON.stringify({ level: "error", err: String(error), shopifyOrderId: candidate.shopifyOrderId, msg: "webhook_processing_failed" }),
    );
    return new Response(JSON.stringify({ error: "processing_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleShopifyWebhook(req));
}
