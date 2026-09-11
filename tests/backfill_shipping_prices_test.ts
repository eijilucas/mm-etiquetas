import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { backfillShippingPrices } from "../supabase/functions/_shared/reconciliation.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withFetchMock(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init ?? {});
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }
  return run().finally(() => {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    store_key: "basico",
    shopify_order_id: "1",
    shopify_order_number: "1",
    shipping_price: 27.9,
    ...overrides,
  };
}

const lucroLiquidoEnv = {
  LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
  LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
};

Deno.test("sends valor_frete (not diferenca_frete) for each order in the page", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder());

  const calls: unknown[] = [];
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url, init) => {
        if (url.includes("/shipping-cost-callback")) {
          calls.push(init.body ? JSON.parse(init.body as string) : undefined);
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await backfillShippingPrices(fake as any, config, 0);
        assertEquals(result, { checked: 1, reported: 1, offset: 0, limit: 12, total: 1, hasMore: false });
        assertEquals(calls, [{ shopify_order_id: "1", order_number: "1", valor_frete: 27.9 }]);
      },
    ),
  );
});

Deno.test("excludes external orders and orders without shipping_price", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-external", store_key: "external", shopify_order_id: "uuid-1" }));
  fake.table("orders_shipping").push(makeOrder({ id: "row-no-price", shopify_order_id: "2", shipping_price: null }));

  let called = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        called = true;
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await backfillShippingPrices(fake as any, config, 0);
        assertEquals(result, { checked: 0, reported: 0, offset: 0, limit: 12, total: 0, hasMore: false });
        assertEquals(called, false);
      },
    ),
  );
});

Deno.test("paginates: hasMore is true mid-way, false on the last page", async () => {
  const fake = makeFakeSupabase();
  for (let i = 1; i <= 15; i += 1) {
    const id = String(i).padStart(2, "0");
    fake.table("orders_shipping").push(makeOrder({ id: `row-${id}`, shopify_order_id: id, shopify_order_number: id }));
  }

  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        if (url.includes("/shipping-cost-callback")) return jsonResponse({ ok: true });
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const first = await backfillShippingPrices(fake as any, config, 0);
        assertEquals(first, { checked: 12, reported: 12, offset: 0, limit: 12, total: 15, hasMore: true });

        // deno-lint-ignore no-explicit-any
        const second = await backfillShippingPrices(fake as any, config, 12);
        assertEquals(second, { checked: 3, reported: 3, offset: 12, limit: 12, total: 15, hasMore: false });
      },
    ),
  );
});
