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

// This endpoint also receives orders/updated (address edits, discounts,
// etc.), which fires regardless of payment status -- a not-yet-paid order
// must never land in pending_approval just because it changed.
Deno.test("does not persist an order whose financial_status isn't paid (orders/updated on an unpaid order)", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify({ ...shopifyOrderPayload(), financial_status: "pending" });
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
    assertEquals(await res.json(), { ok: true, skipped: "not_paid" });
    assertEquals(fake.table("orders_shipping").length, 0);
  });
});

// Confirmed live: an order fulfilled entirely outside this system (a
// different app/process) still fired orders/updated later and landed in
// pending_approval looking like a fresh, ready-to-ship order.
Deno.test("does not persist an order that's already fulfilled elsewhere", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify({ ...shopifyOrderPayload(), fulfillment_status: "fulfilled" });
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
    assertEquals(await res.json(), { ok: true, skipped: "already_fulfilled" });
    assertEquals(fake.table("orders_shipping").length, 0);
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

Deno.test("tracking-preview batches one Melhor Envio call and applies the melhorenvio_tracking fallback", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    { id: "order-a", store_key: "test", shopify_order_id: "6001", status: "label_generated", melhor_envio_order_id: "me-a" },
    { id: "order-b", store_key: "test", shopify_order_id: "6002", status: "failed", melhor_envio_order_id: "me-b" },
    // no melhor_envio_order_id yet — must be silently skipped, not error out.
    { id: "order-c", store_key: "test", shopify_order_id: "6003", status: "cart_created", melhor_envio_order_id: null },
  );

  let trackingCallCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/me/shipment/tracking")) {
      trackingCallCount += 1;
      const body = JSON.parse(init?.body as string);
      assertEquals(body.orders.sort(), ["me-a", "me-b"]);
      return new Response(
        JSON.stringify({
          "me-a": { id: "me-a", tracking: "AA123456785BR" },
          "me-b": { id: "me-b", tracking: null, melhorenvio_tracking: "ME262CMAHI0BR" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  const req = new Request("http://localhost/functions/v1/orders-api/tracking-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-a", "order-b", "order-c"] }),
  });

  let json: { previews: Record<string, string | null> };
  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  assertEquals(trackingCallCount, 1);
  assertEquals(json.previews, { "order-a": "AA123456785BR", "order-b": "ME262CMAHI0BR" });
});

function makePreviewOrder(id: string, orderNumber: string) {
  return {
    id,
    store_key: "test",
    shopify_order_id: orderNumber,
    status: "pending_approval",
    items: [{ shopifyLineItemId: 1, title: "Camiseta", variantTitle: null, sku: "CAM-1", quantity: 1, unitPrice: "89.90", grams: 300 }],
    shipping_address: { zip: "01310-930", address1: "Av. Paulista, 1000", city: "Sao Paulo", province_code: "SP", document: "12345678900" },
  };
}

Deno.test("approve-preview flags an insufficient balance for the batch total", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makePreviewOrder("order-p1", "8001"), makePreviewOrder("order-p2", "8002"));

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/me/shipment/calculate")) {
      return new Response(JSON.stringify([{ id: 1, name: "PAC", price: "150.00" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/me/balance")) {
      return new Response(JSON.stringify({ balance: 200, reserved: 0, debts: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  const req = new Request("http://localhost/functions/v1/orders-api/approve-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-p1", "order-p2"] }),
  });

  let json: { estimatedTotal: number; unestimated: number; balance: number | null; sufficient: boolean | null; problems: unknown[] };
  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  assertEquals(json, { estimatedTotal: 300, unestimated: 0, balance: 200, sufficient: false, problems: [] });
});

Deno.test("approve-preview reports sufficient when the balance covers the estimated total", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makePreviewOrder("order-p1", "8001"));

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/me/shipment/calculate")) {
      return new Response(JSON.stringify([{ id: 1, name: "PAC", price: "24.50" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/me/balance")) {
      return new Response(JSON.stringify({ balance: 500, reserved: 0, debts: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  const req = new Request("http://localhost/functions/v1/orders-api/approve-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-p1"] }),
  });

  let json: { estimatedTotal: number; unestimated: number; balance: number | null; sufficient: boolean | null; problems: unknown[] };
  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  assertEquals(json, { estimatedTotal: 24.5, unestimated: 0, balance: 500, sufficient: true, problems: [] });
});

Deno.test("approve-preview flags a missing recipient document as blocking, and a missing quote as a warning", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    // No document anywhere, and the GraphQL lookup also comes back empty —
    // this one is a guaranteed failure if approved as-is.
    { ...makePreviewOrder("order-nodoc", "8003"), shipping_address: { zip: "01310-930", address1: "Av. Paulista, 1000", city: "Sao Paulo", province_code: "SP" } },
    // Has a document, but no carrier serves this CEP — softer signal only.
    { ...makePreviewOrder("order-noquote", "8004"), shipping_address: { zip: "99999-999", address1: "Rua X", city: "Y", province_code: "Z", document: "12345678900" } },
  );

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes("/me/shipment/calculate")) {
      const zip = body?.to?.postal_code;
      if (zip === "99999999") return new Response(JSON.stringify([{ id: 1, name: "PAC", price: "0", error: "CEP nao atendido" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify([{ id: 1, name: "PAC", price: "24.50" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/me/balance")) {
      return new Response(JSON.stringify({ balance: 500, reserved: 0, debts: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "shpat_test", scope: "read_orders", expires_in: 86399 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/graphql.json") && typeof body?.query === "string" && body.query.includes("GetLocalizationExtensions")) {
      return new Response(JSON.stringify({ data: { order: { localizationExtensions: { edges: [] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  const req = new Request("http://localhost/functions/v1/orders-api/approve-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
    body: JSON.stringify({ ids: ["order-nodoc", "order-noquote"] }),
  });

  let json: { problems: { id: string; orderNumber: string | null; blocking: string[]; warnings: string[] }[] };
  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  const nodoc = json.problems.find((p) => p.id === "order-nodoc");
  const noquote = json.problems.find((p) => p.id === "order-noquote");
  assertEquals(nodoc?.blocking.length, 1);
  assertEquals(noquote?.blocking.length, 0);
  assertEquals(noquote?.warnings.length, 1);
});

Deno.test("archives a held order so it drops out of every panel tab", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-held",
    store_key: "test",
    shopify_order_id: "7001",
    status: "held",
    held_reason: "CEP invalido, comprado na mao pela Melhor Envio",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-held/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "archived");
  assertEquals(order.archived_by, "tester@example.com");
});

Deno.test("archives a failed order resolved entirely by hand outside the system", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-failed",
    store_key: "test",
    shopify_order_id: "7003",
    status: "failed",
    last_error: "Melhor Envio API error 422: sem detalhes na resposta",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-failed/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(fake.table("orders_shipping")[0].status, "archived");
});

Deno.test("refuses to archive an order that isn't held or failed", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-pending",
    store_key: "test",
    shopify_order_id: "7002",
    status: "pending_approval",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-pending/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 400);
  assertEquals(fake.table("orders_shipping")[0].status, "pending_approval");
});
