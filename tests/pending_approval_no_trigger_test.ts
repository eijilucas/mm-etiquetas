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

// Confirmed live: an order fulfilled entirely outside this system (bought
// on Melhor Envio's site by hand, fulfilled directly in Shopify's admin)
// still fired orders/updated later and landed in pending_approval looking
// like a fresh, ready-to-ship order. It must never re-enter the approval
// queue, but it's recorded as "external" instead of silently dropped, so
// there's still a record it exists.
Deno.test("records an order that's already fulfilled elsewhere as external, not pending_approval", async () => {
  const fake = makeFakeSupabase();
  const payload = JSON.stringify({
    ...shopifyOrderPayload(),
    fulfillment_status: "fulfilled",
    fulfillments: [{ status: "success", tracking_company: "Other", tracking_number: "AD123456789BR" }],
  });
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
    assertEquals(await res.json(), { ok: true, recorded: "external" });
    const rows = fake.table("orders_shipping");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, "external");
    assertEquals(rows[0].tracking_code, "AD123456789BR");
    assertEquals(rows[0].tracking_company, "Other");
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

// Confirmed live: Melhor Envio rejects to.address over 64 chars with a 422
// ("Endereco de destino - 64 caracteres"), which buildCartPayload can't
// recover from — same severity as the missing-document check above.
Deno.test("approve-preview flags an address over Melhor Envio's 64-char limit as blocking", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    ...makePreviewOrder("order-longaddr", "8005"),
    shipping_address: {
      zip: "65350-000",
      // Real example that failed live — 68 chars, no trailing house number.
      address1: "Rua Manijituba segunda travessia , Sn , em frente a maconaria, Sn",
      city: "Vitoria do Mearim",
      province_code: "MA",
      document: "12345678900",
    },
  });

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

  let json: { problems: { id: string; blocking: string[] }[] };
  try {
    const req = new Request("http://localhost/functions/v1/orders-api/approve-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
      body: JSON.stringify({ ids: ["order-longaddr"] }),
    });
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  const problem = json.problems.find((p) => p.id === "order-longaddr");
  assertEquals(problem?.blocking.length, 1);
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

Deno.test("archives a tracking_ready order that shouldn't be sent / was handled by hand", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-ready",
    store_key: "test",
    shopify_order_id: "7004",
    status: "tracking_ready",
    tracking_code: "ME262D522P9BR",
    melhor_envio_order_id: "me-ready",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-ready/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(fake.table("orders_shipping")[0].status, "archived");
});

Deno.test("refuses to archive an order that isn't held, failed or tracking_ready", async () => {
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

// Covers the two things most likely to break silently: pagination (Shopify
// returns the Link header cursor, not an offset) and never overwriting an
// order that's already further along in our own pipeline.
Deno.test("external backfill paginates through Shopify and skips orders already in our pipeline", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-already-tracked",
    store_key: "test",
    shopify_order_id: "9001",
    status: "tracking_synced",
    tracking_code: "REAL-CODE-123",
  });

  function externalOrderPayload(id: number) {
    return {
      id,
      order_number: id,
      admin_graphql_api_id: `gid://shopify/Order/${id}`,
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      currency: "BRL",
      total_price: "150.00",
      processed_at: "2026-08-20T09:00:00Z",
      customer: { first_name: "Maria", last_name: "Lima", email: "maria@example.com" },
      shipping_address: { address1: "Rua Z", city: "Recife", province_code: "PE", zip: "50000-000" },
      line_items: [{ id: 1, title: "Boné", sku: "BON-2", quantity: 1, price: "150.00", grams: 200 }],
      fulfillments: [{ status: "success", tracking_company: "Other", tracking_number: `TRACK-${id}` }],
    };
  }

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    if (url.includes("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "shpat_test", scope: "read_orders", expires_in: 86399 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orders.json") && url.includes("page_info=next")) {
      return new Response(JSON.stringify({ orders: [externalOrderPayload(9003)] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orders.json")) {
      return new Response(JSON.stringify({ orders: [{ ...externalOrderPayload(9001), id: 9001, order_number: 9001 }, externalOrderPayload(9002)] }), {
        status: 200,
        headers: { "Content-Type": "application/json", Link: '<https://test.myshopify.com/admin/api/2024-01/orders.json?page_info=next>; rel="next"' },
      });
    }
    if (url.includes("/graphql.json") && typeof body?.query === "string" && body.query.includes("currentQuantity")) {
      return new Response(JSON.stringify({
        data: { order: { currentTotalPriceSet: { shopMoney: { amount: "150.00" } }, lineItems: { edges: [{ node: { id: "gid://shopify/LineItem/1", currentQuantity: 1 } }] } } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  let json: { recorded: number; skipped: number };
  try {
    const req = new Request("http://localhost/functions/v1/orders-api/external/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
      body: JSON.stringify({ days: 90 }),
    });
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(req, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  } finally {
    globalThis.fetch = original;
  }

  // 3 orders seen across both pages, but #9001 already exists as
  // tracking_synced -- skipped, never overwritten.
  assertEquals(json.recorded, 2);
  assertEquals(json.skipped, 1);

  const rows = fake.table("orders_shipping");
  assertEquals(rows.find((r) => r.shopify_order_id === "9001")?.status, "tracking_synced");
  assertEquals(rows.find((r) => r.shopify_order_id === "9001")?.tracking_code, "REAL-CODE-123");
  assertEquals(rows.find((r) => r.shopify_order_id === "9002")?.status, "external");
  assertEquals(rows.find((r) => r.shopify_order_id === "9003")?.status, "external");
  assertEquals(rows.find((r) => r.shopify_order_id === "9003")?.tracking_code, "TRACK-9003");
});

Deno.test("restore infers held from held_at, since /archive never clears it", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-was-held",
    store_key: "external",
    shopify_order_id: "7101",
    status: "archived",
    held_reason: "CEP invalido",
    held_at: "2026-09-08T10:00:00Z",
    archived_at: "2026-09-08T11:00:00Z",
    archived_by: "vitor@m3ntalmadness.com",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-was-held/restore", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, status: "held" });
  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "held");
  assertEquals(order.archived_at, null);
  assertEquals(order.archived_by, null);
});

Deno.test("restore infers tracking_ready from a tracking_code left over, when there's no held_at", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-was-ready",
    store_key: "external",
    shopify_order_id: "7102",
    status: "archived",
    tracking_code: "ME262D522P9BR",
    melhor_envio_order_id: "me-ready",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-was-ready/restore", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, status: "tracking_ready" });
  assertEquals(fake.table("orders_shipping")[0].status, "tracking_ready");
});

Deno.test("restore falls back to failed when neither held_at nor tracking_code is set", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-was-failed",
    store_key: "external",
    shopify_order_id: "7103",
    status: "archived",
    last_error: "Melhor Envio API error 422: sem detalhes na resposta",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-was-failed/restore", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, status: "failed" });
  assertEquals(fake.table("orders_shipping")[0].status, "failed");
});

Deno.test("refuses to restore an order that isn't archived", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-not-archived",
    store_key: "test",
    shopify_order_id: "7104",
    status: "failed",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/order-not-archived/restore", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 400);
  assertEquals(fake.table("orders_shipping")[0].status, "failed");
});

Deno.test("GET /archived returns failed, held and removed orders, newest activity first", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    { id: "a1", store_key: "external", shopify_order_id: "7105", status: "archived", archived_at: "2026-09-08T09:00:00Z", archived_by: "vitor@m3ntalmadness.com", updated_at: "2026-09-08T09:00:00Z" },
    { id: "a2", store_key: "external", shopify_order_id: "7106", status: "archived", archived_at: "2026-09-08T12:00:00Z", archived_by: "vitor@m3ntalmadness.com", updated_at: "2026-09-08T12:00:00Z" },
    { id: "a3", store_key: "test", shopify_order_id: "7107", status: "failed", last_error: "erro qualquer", updated_at: "2026-09-08T15:00:00Z" },
    { id: "a4", store_key: "test", shopify_order_id: "7108", status: "tracking_ready", updated_at: "2026-09-08T20:00:00Z" },
    { id: "a5", store_key: "test", shopify_order_id: "7109", status: "held", held_reason: "cancelado", updated_at: "2026-09-08T18:00:00Z" },
  );

  const req = new Request("http://localhost/functions/v1/orders-api/archived", {
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  const { orders } = await res.json();
  // a4 (tracking_ready) excluded; failed + held + archived, updated_at desc.
  assertEquals(orders.map((o: { id: string }) => o.id), ["a5", "a3", "a2", "a1"]);
});

Deno.test("back-to-queue sends a failed order (no shipping bought) back to pending_approval", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "f1",
    store_key: "test",
    shopify_order_id: "7201",
    status: "failed",
    last_error: "endereco invalido",
    melhor_envio_order_id: null,
  });

  const req = new Request("http://localhost/functions/v1/orders-api/f1/back-to-queue", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "pending_approval");
  assertEquals(order.last_error, null);
});

Deno.test("back-to-queue refuses a failed order that already bought shipping on Melhor Envio", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "f2",
    store_key: "test",
    shopify_order_id: "7202",
    status: "failed",
    melhor_envio_order_id: "me-order-77",
  });

  const req = new Request("http://localhost/functions/v1/orders-api/f2/back-to-queue", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 400);
  assertEquals(fake.table("orders_shipping")[0].status, "failed");
});

Deno.test("back-to-queue refuses an order that isn't failed", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({ id: "f3", store_key: "test", shopify_order_id: "7203", status: "tracking_ready" });

  const req = new Request("http://localhost/functions/v1/orders-api/f3/back-to-queue", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 400);
});

Deno.test("archive accepts an 'external' order, and restore sends it back to external", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "e1",
    store_key: "external",
    shopify_order_id: "7301",
    status: "external",
    tracking_code: "AA123456785BR",
    tracking_company: "Correios",
    melhor_envio_order_id: null,
    held_at: null,
  });

  const archiveReq = new Request("http://localhost/functions/v1/orders-api/e1/archive", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
  // deno-lint-ignore no-explicit-any
  assertEquals((await handleOrdersApi(archiveReq, { config, supabase: fake as any })).status, 200);
  assertEquals(fake.table("orders_shipping")[0].status, "archived");

  const restoreReq = new Request("http://localhost/functions/v1/orders-api/e1/restore", {
    method: "POST",
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(restoreReq, { config, supabase: fake as any });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, status: "external" });
  assertEquals(fake.table("orders_shipping")[0].status, "external");
});

function withShopifyOrderLookupMock(order: unknown | null, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test", scope: "read_orders", expires_in: 86399 });
    }
    if (url.includes("/orders.json") && url.includes("name=")) {
      return jsonResponse({ orders: order ? [order] : [] });
    }
    if (url.includes("/graphql.json")) {
      return jsonResponse({ data: { order: { currentTotalPriceSet: null, lineItems: { edges: [] } } } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function diagnoseOrderReq(storeKey: string, orderNumber: string) {
  return new Request(`http://localhost/functions/v1/orders-api/diagnose-order?storeKey=${storeKey}&orderNumber=${orderNumber}`, {
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });
}

Deno.test("diagnose-order reports not found when the order doesn't exist on Shopify at all", async () => {
  const fake = makeFakeSupabase();
  let json: { foundInShopify: boolean };
  await withShopifyOrderLookupMock(null, async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(diagnoseOrderReq("test", "9999"), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  });
  assertEquals(json!.foundInShopify, false);
});

Deno.test("diagnose-order reports a real mapping failure instead of just 'missing' (reproduces #3441-style incidents)", async () => {
  const fake = makeFakeSupabase();
  const brokenOrder = {
    id: 9201,
    order_number: 3441,
    admin_graphql_api_id: "gid://shopify/Order/9201",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    total_price: "199.90",
    // line_items intentionally missing, same as the reconciliation alert test
  };

  let json: { foundInShopify: boolean; existingRows: unknown[]; mapping: { ok: boolean; error?: string } };
  await withShopifyOrderLookupMock(brokenOrder, async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(diagnoseOrderReq("test", "3441"), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  });

  assertEquals(json!.foundInShopify, true);
  assertEquals(json!.existingRows, []);
  assertEquals(json!.mapping.ok, false);
  assertEquals(json!.mapping.error!.includes("Cannot read properties of undefined"), true);
});

Deno.test("diagnose-order surfaces an existing row even when it isn't pending_approval, so 'missing' isn't confused with 'hiding elsewhere'", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "row-1",
    store_key: "test",
    shopify_order_id: "9202",
    status: "held",
    held_reason: "CEP invalido",
    updated_at: "2026-09-08T10:00:00Z",
  });
  const goodOrder = {
    id: 9202,
    order_number: 3419,
    admin_graphql_api_id: "gid://shopify/Order/9202",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    total_price: "99.90",
    line_items: [{ id: 1, title: "Bone", variant_title: null, sku: "BON-1", quantity: 1, price: "99.90", grams: 150 }],
  };

  let json: { existingRows: { status: string; held_reason: string }[] };
  await withShopifyOrderLookupMock(goodOrder, async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleOrdersApi(diagnoseOrderReq("test", "3419"), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    json = await res.json();
  });

  assertEquals(json!.existingRows.length, 1);
  assertEquals(json!.existingRows[0].status, "held");
  assertEquals(json!.existingRows[0].held_reason, "CEP invalido");
});

Deno.test("diagnose-order rejects an unknown store key", async () => {
  const fake = makeFakeSupabase();
  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(diagnoseOrderReq("nao-existe", "3441"), { config, supabase: fake as any });
  assertEquals(res.status, 400);
});

Deno.test("kpi-counts returns head:true counts per bucket, not full rows", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    { id: "o1", store_key: "test", shopify_order_id: "1", status: "pending_approval" },
    { id: "o2", store_key: "test", shopify_order_id: "2", status: "pending_approval" },
    { id: "o3", store_key: "test", shopify_order_id: "3", status: "approved" },
    { id: "o4", store_key: "test", shopify_order_id: "4", status: "tracking_ready" },
    { id: "o5", store_key: "test", shopify_order_id: "5", status: "tracking_synced" },
    { id: "o6", store_key: "test", shopify_order_id: "6", status: "failed" },
    { id: "o7", store_key: "test", shopify_order_id: "7", status: "held" },
    { id: "o8", store_key: "test", shopify_order_id: "8", status: "external" },
  );

  const req = new Request("http://localhost/functions/v1/orders-api/kpi-counts", {
    headers: { Authorization: `Bearer ${fakeUserJwt("tester@example.com")}` },
  });

  // deno-lint-ignore no-explicit-any
  const res = await handleOrdersApi(req, { config, supabase: fake as any });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { pending: 2, processing: 2, completed: 1, failed: 1 });
});
