import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleShopifyWebhook } from "../supabase/functions/shopify-webhook/index.ts";
import { handleOrdersApi } from "../supabase/functions/orders-api/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

function shopifyOrderPayload() {
  return {
    id: 5001,
    order_number: 5001,
    admin_graphql_api_id: "gid://shopify/Order/5001",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    total_price: "199.90",
    processed_at: "2026-08-18T09:00:00Z",
    customer: { first_name: "Joao", last_name: "Souza", email: "joao@example.com" },
    shipping_address: { address1: "Rua Y", city: "Curitiba", province_code: "PR", zip: "80000-000" },
    line_items: [{ id: 1, title: "Bone", sku: "BON-1", quantity: 2, price: "99.95", grams: 150 }],
  };
}

async function sign(body: string, secret: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const config = loadConfig();
const secret = "test-webhook-secret";

// orders-api now gates on a real Supabase session JWT (verify_jwt = true at
// the gateway, decoded-only in getAuthenticatedUser) instead of a shared
// token — this builds a fake-but-well-formed one for tests, no real
// signature needed since the gateway would have already verified it.
function fakeUserJwt(email: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ role: "authenticated", email, sub: "test-user-id" }));
  return `${header}.${payload}.fakesignature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// mapShopifyOrderToCandidate now makes a live GraphQL call (current line
// item quantities/total, see shopify.ts) — every webhook test needs this
// mocked even when it isn't the point of the test.
function withShopifyGraphqlMock(fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test-fetched", scope: "read_orders", expires_in: 86399 });
    }
    if (url.includes("/graphql.json")) {
      return jsonResponse({
        data: {
          order: {
            currentTotalPriceSet: { shopMoney: { amount: "199.90" } },
            lineItems: { edges: [{ node: { id: "gid://shopify/LineItem/1", currentQuantity: 2 } }] },
          },
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function pipelineSpy() {
  const calls: string[] = [];
  const fn = async (_supabase: unknown, _config: unknown, orderShippingId: string) => {
    calls.push(orderShippingId);
  };
  return { fn: fn as unknown as typeof import("../supabase/functions/_shared/pipeline.ts").runShippingPipeline, calls };
}

function cancelOrderSpy() {
  const calls: { orderShippingId: string; reason: string }[] = [];
  const fn = async (_supabase: unknown, _config: unknown, orderShippingId: string, reason: string) => {
    calls.push({ orderShippingId, reason });
  };
  return { fn: fn as unknown as typeof import("../supabase/functions/_shared/pipeline.ts").cancelOrderLabel, calls };
}

Deno.test("does not enqueue a shipping job when the orders/paid webhook arrives", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify(shopifyOrderPayload());
  const hmac = await sign(payload, secret);

  await withShopifyGraphqlMock(async () => {
    const req = new Request("http://localhost/functions/v1/shopify-webhook/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac },
      body: payload,
    });

    // deno-lint-ignore no-explicit-any
    const res = await handleShopifyWebhook(req, { config, supabase: fake as any });

    assertEquals(res.status, 200);
    const rows = fake.table("orders_shipping");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, "pending_approval");
  });
});

Deno.test("rejects the webhook and persists nothing when the HMAC is invalid", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify(shopifyOrderPayload());

  await withShopifyGraphqlMock(async () => {
    const req = new Request("http://localhost/functions/v1/shopify-webhook/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": "not-a-valid-signature" },
      body: payload,
    });

    // deno-lint-ignore no-explicit-any
    const res = await handleShopifyWebhook(req, { config, supabase: fake as any });

    assertEquals(res.status, 401);
    assertEquals(fake.table("orders_shipping").length, 0);
  });
});

Deno.test("does not enqueue a shipping job even when the webhook fires repeatedly (duplicate delivery)", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify(shopifyOrderPayload());
  const hmac = await sign(payload, secret);

  await withShopifyGraphqlMock(async () => {
    for (let i = 0; i < 3; i += 1) {
      const req = new Request("http://localhost/functions/v1/shopify-webhook/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac },
        body: payload,
      });
      // deno-lint-ignore no-explicit-any
      await handleShopifyWebhook(req, { config, supabase: fake as any });
    }

    assertEquals(fake.table("orders_shipping").length, 1);
  });
});

Deno.test("only runs the pipeline once an order is explicitly approved through the API", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-1",
    store_key: "test",
    shopify_order_id: "5001",
    shopify_order_number: "5001",
    status: "pending_approval",
    items: [],
    shipping_address: {},
    financial_status: "paid",
    total_price: "199.90",
    currency: "BRL",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const spy = pipelineSpy();
  const req = new Request("http://localhost/functions/v1/orders-api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-1"] }),
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any, runPipeline: spy.fn });

  assertEquals(res.status, 200);
  assertEquals(fake.table("orders_shipping")[0].status, "approved");
  assertEquals(fake.table("orders_shipping")[0].approved_by, "tester@example.com");
  assertEquals(spy.calls, ["order-1"]);
});

Deno.test("does not hold an order that isn't pending_approval (mirrors the guard /revert already has)", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-shipped",
    store_key: "test",
    shopify_order_id: "5002",
    status: "tracking_synced",
    tracking_code: "ME123",
    items: [],
    shipping_address: {},
    financial_status: "paid",
    total_price: "99.90",
    currency: "BRL",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const req = new Request("http://localhost/functions/v1/orders-api/hold", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-shipped"], reason: "engano" }),
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(fake.table("orders_shipping")[0].status, "tracking_synced");
  assertEquals(fake.table("orders_shipping")[0].held_reason, undefined);
});

Deno.test("cancels the label for a processing order and calls cancelOrderLabel with the given reason", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-purchased",
    store_key: "test",
    shopify_order_id: "5003",
    status: "label_generated",
    melhor_envio_order_id: "me-order-9",
    items: [],
    shipping_address: {},
    financial_status: "paid",
    total_price: "199.90",
    currency: "BRL",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const spy = cancelOrderSpy();
  const req = new Request("http://localhost/functions/v1/orders-api/order-purchased/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ reason: "endereco errado" }),
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any, cancelOrder: spy.fn });

  assertEquals(res.status, 200);
  assertEquals(spy.calls, [{ orderShippingId: "order-purchased", reason: "endereco errado" }]);
});

Deno.test("rejects cancel without a reason", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-purchased",
    store_key: "test",
    shopify_order_id: "5003",
    status: "label_generated",
    items: [],
    shipping_address: {},
    financial_status: "paid",
    total_price: "199.90",
    currency: "BRL",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const spy = cancelOrderSpy();
  const req = new Request("http://localhost/functions/v1/orders-api/order-purchased/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({}),
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any, cancelOrder: spy.fn });

  assertEquals(res.status, 400);
  assertEquals(spy.calls, []);
});

Deno.test("rejects cancel on an order that's still pending_approval or already held", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-pending",
    store_key: "test",
    shopify_order_id: "5004",
    status: "pending_approval",
    items: [],
    shipping_address: {},
    financial_status: "paid",
    total_price: "199.90",
    currency: "BRL",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const spy = cancelOrderSpy();
  const req = new Request("http://localhost/functions/v1/orders-api/order-pending/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ reason: "engano" }),
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any, cancelOrder: spy.fn });

  assertEquals(res.status, 400);
  assertEquals(spy.calls, []);
});

Deno.test("rejects orders-api routes without a valid bearer token", async () => {
  const fake = makeFakeSupabase();
  const req = new Request("http://localhost/functions/v1/orders-api/pending", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });
  assertEquals(res.status, 401);
});
