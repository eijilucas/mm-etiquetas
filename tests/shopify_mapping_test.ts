import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { mapShopifyOrderToCandidate } from "../supabase/functions/_shared/shopify.ts";
import { loadConfig, getStoreByKey } from "../supabase/functions/_shared/config.ts";

const config = loadConfig();
const store = getStoreByKey(config, "test")!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withFetchMock(handler: (url: string) => Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test-fetched", scope: "read_orders", expires_in: 86399 });
    }
    return handler(url);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function shopifyOrderWithSwappedItem() {
  return {
    id: 7622037864686,
    order_number: 3120,
    admin_graphql_api_id: "gid://shopify/Order/7622037864686",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    // Stale REST total — reflects both line items, including the removed one.
    total_price: "498.48",
    processed_at: "2026-08-20T09:00:00Z",
    customer: { first_name: "Maria", last_name: "Santos", email: "maria@example.com" },
    shipping_address: { address1: "Rua X", city: "Recife", province_code: "PE", zip: "51000-000" },
    line_items: [
      // Swapped out via a Shopify Order Edit — REST still lists it at its
      // original quantity, only GraphQL's currentQuantity shows it's gone.
      { id: 17954485403886, title: "Camiseta Vermelha", variant_title: "P", sku: "CV-P", quantity: 1, price: "229.99", grams: 0 },
      { id: 18030169981166, title: "Camiseta", variant_title: "P", sku: "C-P", quantity: 1, price: "229.99", grams: 0 },
    ],
  };
}

Deno.test("drops a line item that was swapped out via Shopify Order Edit (currentQuantity 0) instead of double-counting it", async () => {
  await withFetchMock(
    (url) => {
      if (url.includes("/graphql.json")) {
        return jsonResponse({
          data: {
            order: {
              currentTotalPriceSet: { shopMoney: { amount: "279.98" } },
              lineItems: {
                edges: [
                  { node: { id: "gid://shopify/LineItem/17954485403886", currentQuantity: 0 } },
                  { node: { id: "gid://shopify/LineItem/18030169981166", currentQuantity: 1 } },
                ],
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    },
    async () => {
      // deno-lint-ignore no-explicit-any
      const candidate = await mapShopifyOrderToCandidate(shopifyOrderWithSwappedItem() as any, store);

      assertEquals(candidate.items.length, 1);
      assertEquals(candidate.items[0].sku, "C-P");
      assertEquals(candidate.items[0].quantity, 1);
      // Real current total, not REST's stale sum of both line items.
      assertEquals(candidate.totalPrice, "279.98");
    },
  );
});

Deno.test("falls back to REST's total_price when GraphQL doesn't return a current total", async () => {
  await withFetchMock(
    (url) => {
      if (url.includes("/graphql.json")) {
        return jsonResponse({ data: { order: { currentTotalPriceSet: null, lineItems: { edges: [] } } } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    },
    async () => {
      const order = shopifyOrderWithSwappedItem();
      // deno-lint-ignore no-explicit-any
      const candidate = await mapShopifyOrderToCandidate(order as any, store);
      assertEquals(candidate.totalPrice, "498.48");
      // No currentQuantity data at all -> falls back to REST quantity per item.
      assertEquals(candidate.items.length, 2);
    },
  );
});
