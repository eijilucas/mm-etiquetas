import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { manualTrackingSync } from "../supabase/functions/_shared/pipeline.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-manual-1",
    store_key: "test",
    shopify_order_id: "9301",
    shopify_order_number: "9301",
    shopify_graphql_id: "gid://shopify/Order/9301",
    customer_name: "Hugo Meneguesso",
    status: "failed",
    last_error: "Melhor Envio API error 422: O to.postal code informado e invalido",
    melhor_envio_order_id: null,
    tracking_code: null,
    ...overrides,
  };
}

// Mocks the Shopify OAuth token exchange plus the two GraphQL calls
// createFulfillment makes (fetch the open fulfillment order, then create the
// fulfillment) — same shape as the mocks already used against createFulfillment
// in happy_path_test.ts.
function withShopifyFulfillmentMock(fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test-fetched", scope: "write_fulfillments", expires_in: 86399 });
    }
    if (url.includes("/graphql.json") && typeof body?.query === "string" && body.query.includes("GetFulfillmentOrders")) {
      return jsonResponse({
        data: { order: { fulfillmentOrders: { edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } }] } } },
      });
    }
    if (url.includes("/graphql.json") && typeof body?.query === "string" && body.query.includes("FulfillmentCreateV2")) {
      return jsonResponse({
        data: {
          fulfillmentCreateV2: {
            fulfillment: { id: "gid://shopify/Fulfillment/manual-1", status: "SUCCESS", trackingInfo: [{ number: "HAND-ENTERED-1", url: "" }] },
            userErrors: [],
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

Deno.test("hands a manually-typed tracking code to Shopify for an order that never got a Melhor Envio purchase", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder());

  await withShopifyFulfillmentMock(async () => {
    // deno-lint-ignore no-explicit-any
    await manualTrackingSync(fake as any, config, "order-manual-1", "HAND-ENTERED-1");
  });

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "tracking_synced");
  assertEquals(order.tracking_code, "HAND-ENTERED-1");
  assertEquals(order.shopify_fulfillment_id, "gid://shopify/Fulfillment/manual-1");
  assertEquals(order.last_error, null);
});

Deno.test("works from held status too, not just failed", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ status: "held", held_reason: "CEP invalido, comprado na mao" }));

  await withShopifyFulfillmentMock(async () => {
    // deno-lint-ignore no-explicit-any
    await manualTrackingSync(fake as any, config, "order-manual-1", "HAND-ENTERED-2");
  });

  assertEquals(fake.table("orders_shipping")[0].status, "tracking_synced");
});

Deno.test("refuses to overwrite an order that already has a synced tracking code", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ status: "tracking_synced", tracking_code: "ALREADY-SET" }));

  let threw = false;
  try {
    // deno-lint-ignore no-explicit-any
    await manualTrackingSync(fake as any, config, "order-manual-1", "NEW-CODE");
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
  assertEquals(fake.table("orders_shipping")[0].tracking_code, "ALREADY-SET");
});
