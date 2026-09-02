import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { syncPostedOrders } from "../supabase/functions/_shared/reconciliation.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withFetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init ?? {});
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function makeLiberadoOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    status: "tracking_synced",
    melhor_envio_order_id: "me-order-1",
    label_pdf_url: "https://melhorenvio.com.br/labels/me-order-1.pdf",
    posted_at: null,
    posted_by: null,
    ...overrides,
  };
}

Deno.test("syncs posted_at from Melhor Envio for a released order the carrier has scanned in", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeLiberadoOrder());

  await withFetchMock(
    (url) => {
      if (url.includes("/me/shipment/tracking")) {
        return jsonResponse({ "me-order-1": { id: "me-order-1", status: "posted", posted_at: "2026-08-19 10:00:00" } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    },
    // deno-lint-ignore no-explicit-any
    async () => {
      const result = await syncPostedOrders(fake as any, config);
      assertEquals(result, { checked: 1, posted: 1 });
    },
  );

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.posted_at, "2026-08-19 10:00:00");
});

Deno.test("leaves posted_at untouched when Melhor Envio hasn't recorded a post yet", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeLiberadoOrder());

  await withFetchMock(
    (url) => {
      if (url.includes("/me/shipment/tracking")) {
        return jsonResponse({ "me-order-1": { id: "me-order-1", status: "released", posted_at: null } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    },
    // deno-lint-ignore no-explicit-any
    async () => {
      const result = await syncPostedOrders(fake as any, config);
      assertEquals(result, { checked: 1, posted: 0 });
    },
  );

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.posted_at, null);
});

Deno.test("skips orders that already have posted_at set (manual mark or a prior sync)", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeLiberadoOrder({ posted_at: "2026-08-18T09:00:00Z", posted_by: "vitor@m3ntalmadness.com" }));

  const result = await syncPostedOrders(
    // deno-lint-ignore no-explicit-any
    fake as any,
    config,
  );

  assertEquals(result, { checked: 0, posted: 0 });
  assertEquals(fake.table("orders_shipping")[0].posted_by, "vitor@m3ntalmadness.com");
});

Deno.test("skips orders with no label yet (nothing to post) even if they otherwise qualify", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeLiberadoOrder({ label_pdf_url: null }));

  const result = await syncPostedOrders(
    // deno-lint-ignore no-explicit-any
    fake as any,
    config,
  );

  assertEquals(result, { checked: 0, posted: 0 });
});

Deno.test("reports the new posted_at to the Vendas Externas callback for external orders only", async () => {
  const originalUrl = Deno.env.get("VENDAS_EXTERNAS_FUNCTIONS_URL");
  const originalSecret = Deno.env.get("INTEGRATION_CALLBACK_SECRET");
  Deno.env.set("VENDAS_EXTERNAS_FUNCTIONS_URL", "https://vendas-externas.supabase.co");
  Deno.env.set("INTEGRATION_CALLBACK_SECRET", "test-callback-secret");
  const configWithCallback = loadConfig();

  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    makeLiberadoOrder({ id: "order-external", melhor_envio_order_id: "me-external", store_key: "external", shopify_order_id: "ve-order-1" }),
    makeLiberadoOrder({ id: "order-shopify", melhor_envio_order_id: "me-shopify", store_key: "loja-principal" }),
  );

  const callbackCalls: unknown[] = [];
  try {
    await withFetchMock(
      (url, init) => {
        if (url.includes("/me/shipment/tracking")) {
          return jsonResponse({
            "me-external": { id: "me-external", status: "posted", posted_at: "2026-08-19 10:00:00" },
            "me-shopify": { id: "me-shopify", status: "posted", posted_at: "2026-08-19 10:00:00" },
          });
        }
        if (url.includes("/functions/v1/integration-callback")) {
          callbackCalls.push(JSON.parse(init.body as string));
          return jsonResponse({ received: true });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      },
      // deno-lint-ignore no-explicit-any
      async () => {
        await syncPostedOrders(fake as any, configWithCallback);
      },
    );
  } finally {
    if (originalUrl === undefined) Deno.env.delete("VENDAS_EXTERNAS_FUNCTIONS_URL");
    else Deno.env.set("VENDAS_EXTERNAS_FUNCTIONS_URL", originalUrl);
    if (originalSecret === undefined) Deno.env.delete("INTEGRATION_CALLBACK_SECRET");
    else Deno.env.set("INTEGRATION_CALLBACK_SECRET", originalSecret);
  }

  // Only the external order gets reported — the Shopify one has nothing to
  // do with Vendas Externas at all.
  assertEquals(callbackCalls.length, 1);
  assertEquals((callbackCalls[0] as { sourceOrderId: string }).sourceOrderId, "ve-order-1");
  assertEquals((callbackCalls[0] as { event: string }).event, "shipping.status_changed");
  assertEquals((callbackCalls[0] as { status: string }).status, "tracking_synced");
  assertEquals((callbackCalls[0] as { metadata: { postedAt: string } }).metadata.postedAt, "2026-08-19 10:00:00");
});

Deno.test("batches every unposted order into a single /me/shipment/tracking call", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(
    makeLiberadoOrder({ id: "order-1", melhor_envio_order_id: "me-order-1" }),
    makeLiberadoOrder({ id: "order-2", melhor_envio_order_id: "me-order-2" }),
  );

  let calls = 0;
  await withFetchMock(
    (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body as string);
      assertEquals(body.orders, ["me-order-1", "me-order-2"]);
      return jsonResponse({
        "me-order-1": { id: "me-order-1", status: "posted", posted_at: "2026-08-19 10:00:00" },
        "me-order-2": { id: "me-order-2", status: "released", posted_at: null },
      });
    },
    // deno-lint-ignore no-explicit-any
    async () => {
      const result = await syncPostedOrders(fake as any, config);
      assertEquals(result, { checked: 2, posted: 1 });
    },
  );

  assertEquals(calls, 1);
});
