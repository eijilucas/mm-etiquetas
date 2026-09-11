import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { backfillLabelCosts } from "../supabase/functions/_shared/reconciliation.ts";
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
    melhor_envio_order_id: "me-order-1",
    status: "tracking_synced",
    created_at: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

const lucroLiquidoEnv = {
  LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
  LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
};
const since = "2026-07-01T00:00:00Z";

Deno.test("uses the local shipping_price without calling Melhor Envio", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder());

  const calls: unknown[] = [];
  let meCalled = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url, init) => {
        if (url.includes("/me/orders/search")) {
          meCalled = true;
          throw new Error("should not call Melhor Envio when shipping_price is already local");
        }
        if (url.includes("/shipping-cost-callback")) {
          calls.push(init.body ? JSON.parse(init.body as string) : undefined);
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(result, { checked: 1, reported: 1, skippedHeld: 0, errors: 0, offset: 0, limit: 8, total: 1, hasMore: false });
        assertEquals(meCalled, false);
        assertEquals(calls, [{ shopify_order_id: "1", order_number: "1", valor_frete: 27.9 }]);
      },
    ),
  );
});

Deno.test("falls back to Melhor Envio when shipping_price is null (legacy order), and picks up diferenca_frete for free", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ shipping_price: null }));

  const calls: unknown[] = [];
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url, init) => {
        if (url.includes("/me/orders/search")) {
          return jsonResponse({ data: [{ id: "me-order-1", price: 25.04, conciliation: { value: 61.92, type: "debit" } }] });
        }
        if (url.includes("/shipping-cost-callback")) {
          calls.push(init.body ? JSON.parse(init.body as string) : undefined);
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(result.checked, 1);
        assertEquals(result.reported, 1);
        assertEquals(result.errors, 0);
        assertEquals(calls, [{ shopify_order_id: "1", order_number: "1", valor_frete: 25.04, diferenca_frete: 61.92 }]);
      },
    ),
  );
});

Deno.test("skips a held (cancelled/refunded) order entirely -- no Melhor Envio call, no callback", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ status: "held" }));

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
        const result = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(result.checked, 1);
        assertEquals(result.skippedHeld, 1);
        assertEquals(result.reported, 0);
        assertEquals(called, false);
      },
    ),
  );
});

Deno.test("excludes external orders and orders before the since cutoff", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-external", store_key: "external", shopify_order_id: "uuid-1" }));
  fake.table("orders_shipping").push(makeOrder({ id: "row-old", shopify_order_id: "2", created_at: "2026-05-01T00:00:00Z" }));

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
        const result = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(result, { checked: 0, reported: 0, skippedHeld: 0, errors: 0, offset: 0, limit: 8, total: 0, hasMore: false });
        assertEquals(called, false);
      },
    ),
  );
});

Deno.test("a Melhor Envio lookup failure counts as an error and doesn't abort the rest of the batch", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-bad", shopify_order_id: "1", shipping_price: null, melhor_envio_order_id: "me-bad" }));
  fake.table("orders_shipping").push(makeOrder({ id: "row-good", shopify_order_id: "2", shipping_price: 30 }));

  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        if (url.includes("/me/orders/search")) return jsonResponse({ message: "erro" }, 500);
        if (url.includes("/shipping-cost-callback")) return jsonResponse({ ok: true });
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(result.checked, 2);
        assertEquals(result.errors, 1);
        assertEquals(result.reported, 1);
      },
    ),
  );
});

Deno.test("paginates with the smaller batch size, reporting hasMore correctly", async () => {
  const fake = makeFakeSupabase();
  for (let i = 1; i <= 10; i += 1) {
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
        const first = await backfillLabelCosts(fake as any, config, 0, since);
        assertEquals(first.checked, 8);
        assertEquals(first.total, 10);
        assertEquals(first.hasMore, true);

        // deno-lint-ignore no-explicit-any
        const second = await backfillLabelCosts(fake as any, config, 8, since);
        assertEquals(second.checked, 2);
        assertEquals(second.hasMore, false);
      },
    ),
  );
});
