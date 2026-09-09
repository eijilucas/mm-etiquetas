import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { runReconciliation } from "../supabase/functions/_shared/reconciliation.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A paid+unfulfilled order with no line_items makes mapShopifyOrderToCandidate
// throw (order.line_items.map on undefined) — stands in for whatever real
// data problem made #3441/#3419 fail to map, without needing to know the
// exact original cause.
function brokenShopifyOrder(id: number, orderNumber: number) {
  return {
    id,
    order_number: orderNumber,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    total_price: "199.90",
    processed_at: "2026-09-08T09:00:00Z",
    customer: { first_name: "Felipe", last_name: "Teste", email: "felipe@example.com" },
    shipping_address: { address1: "Rua Y", city: "Curitiba", province_code: "PR", zip: "80000-000" },
    // line_items intentionally missing
  };
}

function withMockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test("reconciliation alerts (via ALERT_WEBHOOK_URL) when a paid order fails to map into the queue", async () => {
  Deno.env.set("ALERT_WEBHOOK_URL", "https://hooks.example.com/test-alert");
  const config = loadConfig();
  const fake = makeFakeSupabase();

  const alertCalls: unknown[] = [];

  await withMockFetch((url, init) => {
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test", scope: "read_orders", expires_in: 86399 });
    }
    if (url.includes("/orders.json")) {
      return jsonResponse({ orders: [brokenShopifyOrder(9101, 3441)] });
    }
    if (url === "https://hooks.example.com/test-alert") {
      alertCalls.push(JSON.parse(init?.body as string));
      return new Response("ok", { status: 200 });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }, async () => {
    const result = await runReconciliation(fake as unknown as Parameters<typeof runReconciliation>[0], config);
    assertEquals(result.upserted, 0);
  });

  assertEquals(alertCalls.length, 1);
  assertEquals((alertCalls[0] as { text: string }).text.includes("3441"), true);
  // Nunca deve entrar de qualquer jeito na fila quando o mapeamento falhou.
  assertEquals(fake.table("orders_shipping").length, 0);
});

Deno.test("reconciliation does not alert when every paid order maps successfully", async () => {
  Deno.env.set("ALERT_WEBHOOK_URL", "https://hooks.example.com/test-alert");
  const config = loadConfig();
  const fake = makeFakeSupabase();

  const alertCalls: unknown[] = [];

  await withMockFetch((url, init) => {
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test", scope: "read_orders", expires_in: 86399 });
    }
    if (url.includes("/orders.json")) {
      return jsonResponse({
        orders: [
          {
            id: 9102,
            order_number: 3442,
            admin_graphql_api_id: "gid://shopify/Order/9102",
            financial_status: "paid",
            fulfillment_status: null,
            currency: "BRL",
            total_price: "99.90",
            processed_at: "2026-09-08T09:00:00Z",
            customer: { first_name: "Ana", last_name: "Teste", email: "ana@example.com" },
            shipping_address: { address1: "Rua Z", city: "Curitiba", province_code: "PR", zip: "80000-000" },
            line_items: [{ id: 1, title: "Camiseta", variant_title: null, sku: "CAM-1", quantity: 1, price: "99.90", grams: 200 }],
          },
        ],
      });
    }
    if (url.includes("/graphql.json")) {
      return jsonResponse({ data: { order: { currentTotalPriceSet: null, lineItems: { edges: [] } } } });
    }
    if (url === "https://hooks.example.com/test-alert") {
      alertCalls.push(JSON.parse(init?.body as string));
      return new Response("ok", { status: 200 });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }, async () => {
    const result = await runReconciliation(fake as unknown as Parameters<typeof runReconciliation>[0], config);
    assertEquals(result.upserted, 1);
  });

  assertEquals(alertCalls.length, 0);
});
