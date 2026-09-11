import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleReconciliationCron } from "../supabase/functions/reconciliation-cron/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function externalBackfillRequest(since: string) {
  return new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ job: "melhorenvio_external_valor_frete_backfill", since }),
  });
}

Deno.test("job=melhorenvio_external_valor_frete_backfill sends external_order_id for the requested since window", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "row-1",
    store_key: "external",
    shopify_order_id: "uuid-1",
    shopify_order_number: "77",
    shipping_price: 22.16,
    created_at: "2026-09-05T00:00:00Z",
  });

  const originalUrl = Deno.env.get("LUCRO_LIQUIDO_FUNCTIONS_URL");
  const originalSecret = Deno.env.get("LUCRO_LIQUIDO_CALLBACK_SECRET");
  Deno.env.set("LUCRO_LIQUIDO_FUNCTIONS_URL", "https://lucro-liquido.supabase.co");
  Deno.env.set("LUCRO_LIQUIDO_CALLBACK_SECRET", "test-lucro-secret");

  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/shipping-cost-callback")) {
      calls.push(init?.body ? JSON.parse(init.body as string) : undefined);
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(externalBackfillRequest("2026-09-02T00:00:00Z"), {
      config: loadConfig(),
      // deno-lint-ignore no-explicit-any
      supabase: fake as any,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { checked: 1, reported: 1, offset: 0, limit: 12, total: 1, hasMore: false });
    assertEquals(calls, [{ external_order_id: "uuid-1", order_number: "77", valor_frete: 22.16 }]);
  } finally {
    globalThis.fetch = original;
    if (originalUrl === undefined) Deno.env.delete("LUCRO_LIQUIDO_FUNCTIONS_URL");
    else Deno.env.set("LUCRO_LIQUIDO_FUNCTIONS_URL", originalUrl);
    if (originalSecret === undefined) Deno.env.delete("LUCRO_LIQUIDO_CALLBACK_SECRET");
    else Deno.env.set("LUCRO_LIQUIDO_CALLBACK_SECRET", originalSecret);
  }
});
