import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { syncShippingCostDifferences } from "../supabase/functions/_shared/reconciliation.ts";
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
    shopify_order_id: "5834923000001",
    shopify_order_number: "3511",
    tracking_code: "18268300082648",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const lucroLiquidoEnv = {
  LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
  LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
};

Deno.test("finds a conference debit and reports diferenca_frete for a non-external order", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder());

  const calls: Array<{ url: string; body: unknown }> = [];
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url, init) => {
        if (url.includes("/me/orders/search")) {
          return jsonResponse({
            data: [{ tracking: "18268300082648", conciliation: { value: 61.92, type: "debit" } }],
          });
        }
        if (url.includes("/shipping-cost-callback")) {
          calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 1, found: 1, reported: 1 });
        assertEquals(calls.length, 1);
        assertEquals(calls[0].body, {
          shopify_order_id: "5834923000001",
          order_number: "3511",
          diferenca_frete: 61.92,
        });
      },
    ),
  );
});

Deno.test("skips reporting when there's no conciliation difference", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder());

  let callbackCalled = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        if (url.includes("/me/orders/search")) {
          return jsonResponse({ data: [{ tracking: "18268300082648", conciliation: null }] });
        }
        if (url.includes("/shipping-cost-callback")) {
          callbackCalled = true;
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 1, found: 0, reported: 0 });
        assertEquals(callbackCalled, false);
      },
    ),
  );
});

Deno.test("excludes external orders from the candidate query", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-external", store_key: "external", shopify_order_id: "uuid-1" }));

  let meCalled = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        meCalled = true;
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 0, found: 0, reported: 0 });
        assertEquals(meCalled, false);
      },
    ),
  );
});

Deno.test("excludes orders without a tracking code from the candidate query", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-no-tracking", tracking_code: null }));

  let meCalled = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        meCalled = true;
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 0, found: 0, reported: 0 });
        assertEquals(meCalled, false);
      },
    ),
  );
});

Deno.test("excludes orders outside the lookback window", async () => {
  const fake = makeFakeSupabase();
  const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  fake.table("orders_shipping").push(makeOrder({ id: "row-old", updated_at: longAgo }));

  let meCalled = false;
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url) => {
        meCalled = true;
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      async () => {
        const config = loadConfig();
        // deno-lint-ignore no-explicit-any
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 0, found: 0, reported: 0 });
        assertEquals(meCalled, false);
      },
    ),
  );
});

Deno.test("one order's Melhor Envio lookup failing doesn't abort the rest of the batch", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeOrder({ id: "row-bad", shopify_order_id: "1", shopify_order_number: "1", tracking_code: "BAD" }));
  fake.table("orders_shipping").push(makeOrder({ id: "row-good", shopify_order_id: "2", shopify_order_number: "2", tracking_code: "GOOD" }));

  const calls: unknown[] = [];
  await withEnv(lucroLiquidoEnv, () =>
    withFetchMock(
      (url, init) => {
        if (url.includes("/me/orders/search?q=BAD")) {
          return jsonResponse({ message: "erro" }, 500);
        }
        if (url.includes("/me/orders/search?q=GOOD")) {
          return jsonResponse({ data: [{ tracking: "GOOD", conciliation: { value: 12.5, type: "debit" } }] });
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
        const result = await syncShippingCostDifferences(fake as any, config);
        assertEquals(result, { checked: 2, found: 1, reported: 1 });
        assertEquals(calls.length, 1);
      },
    ),
  );
});
