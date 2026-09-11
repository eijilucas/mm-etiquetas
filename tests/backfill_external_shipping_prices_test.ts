import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { backfillExternalShippingPrices } from "../supabase/functions/_shared/reconciliation.ts";
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
    store_key: "external",
    shopify_order_id: "b3b8c1e2-0000-0000-0000-000000000001",
    shopify_order_number: "77",
    shipping_price: 22.16,
    created_at: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

const lucroLiquidoEnv = {
  LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
  LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
};
const since = "2026-09-02T00:00:00Z";

Deno.test("sends external_order_id (not shopify_order_id) for external orders with shipping_price", async () => {
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
        const result = await backfillExternalShippingPrices(fake as any, config, 0, since);
        assertEquals(result, { checked: 1, reported: 1, offset: 0, limit: 12, total: 1, hasMore: false });
        assertEquals(calls, [{ external_order_id: "b3b8c1e2-0000-0000-0000-000000000001", order_number: "77", valor_frete: 22.16 }]);
      },
    ),
  );
});

Deno.test("excludes non-external orders and orders without shipping_price", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-basico", store_key: "basico", shopify_order_id: "1" }));
  fake.table("orders_shipping").push(makeOrder({ id: "row-no-price", shopify_order_id: "uuid-2", shipping_price: null }));

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
        const result = await backfillExternalShippingPrices(fake as any, config, 0, since);
        assertEquals(result, { checked: 0, reported: 0, offset: 0, limit: 12, total: 0, hasMore: false });
        assertEquals(called, false);
      },
    ),
  );
});

Deno.test("excludes orders before the since cutoff", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-old", shopify_order_id: "uuid-old", created_at: "2026-08-01T00:00:00Z" }));

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
        const result = await backfillExternalShippingPrices(fake as any, config, 0, since);
        assertEquals(result.checked, 0);
        assertEquals(called, false);
      },
    ),
  );
});
