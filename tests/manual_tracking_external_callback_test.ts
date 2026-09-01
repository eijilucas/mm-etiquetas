import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { manualTrackingSync } from "../supabase/functions/_shared/pipeline.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

function makeExternalOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-external-1",
    store_key: "external",
    // Pro pedido externo, shopify_order_id carrega o uuid do pedido no
    // Vendas Externas (ver external-order-intake) — nome do campo é
    // reaproveitado do schema original, não um Shopify order de verdade.
    shopify_order_id: "b3b8c1e2-0000-0000-0000-000000000001",
    customer_name: "Cliente Externo",
    customer_email: "cliente@example.com",
    status: "tracking_ready",
    tracking_code: null,
    ...overrides,
  };
}

Deno.test("pedido externo: dispara o callback assinado pro Vendas Externas quando configurado", async () => {
  const originalUrl = Deno.env.get("VENDAS_EXTERNAS_FUNCTIONS_URL");
  const originalSecret = Deno.env.get("INTEGRATION_CALLBACK_SECRET");
  Deno.env.set("VENDAS_EXTERNAS_FUNCTIONS_URL", "https://vendas-externas.supabase.co");
  Deno.env.set("INTEGRATION_CALLBACK_SECRET", "test-callback-secret");
  const config = loadConfig();

  const calls: Array<{ url: string; body: unknown; signature: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      signature: (init?.headers as Record<string, string>)?.["X-Signature"] ?? null,
    });
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const fake = makeFakeSupabase();
    fake.table("orders_shipping").push(makeExternalOrder());

    // deno-lint-ignore no-explicit-any
    await manualTrackingSync(fake as any, config, "order-external-1", "BR123456789");

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://vendas-externas.supabase.co/functions/v1/integration-callback");
    assertEquals(
      (calls[0].body as { sourceOrderId: string }).sourceOrderId,
      "b3b8c1e2-0000-0000-0000-000000000001",
    );
    assertEquals((calls[0].body as { event: string }).event, "shipping.tracking_synced");
    assertEquals((calls[0].body as { metadata: { trackingCode: string } }).metadata.trackingCode, "BR123456789");
    assertEquals(typeof calls[0].signature, "string");
    assertEquals((calls[0].signature ?? "").length, 64); // hex SHA-256

    const order = fake.table("orders_shipping")[0];
    assertEquals(order.status, "tracking_synced");
    assertEquals(order.tracking_code, "BR123456789");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) Deno.env.delete("VENDAS_EXTERNAS_FUNCTIONS_URL");
    else Deno.env.set("VENDAS_EXTERNAS_FUNCTIONS_URL", originalUrl);
    if (originalSecret === undefined) Deno.env.delete("INTEGRATION_CALLBACK_SECRET");
    else Deno.env.set("INTEGRATION_CALLBACK_SECRET", originalSecret);
  }
});

Deno.test("pedido externo: sem VENDAS_EXTERNAS_FUNCTIONS_URL/INTEGRATION_CALLBACK_SECRET configurados, pula o callback sem quebrar", async () => {
  const config = loadConfig(); // test_env.ts não define essas duas — devem estar vazias por padrão

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const fake = makeFakeSupabase();
    fake.table("orders_shipping").push(makeExternalOrder({ id: "order-external-2" }));

    // deno-lint-ignore no-explicit-any
    await manualTrackingSync(fake as any, config, "order-external-2", "BR987654321");

    assertEquals(fetchCalled, false);
    assertEquals(fake.table("orders_shipping")[0].status, "tracking_synced");
    assertEquals(fake.table("orders_shipping")[0].tracking_code, "BR987654321");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
