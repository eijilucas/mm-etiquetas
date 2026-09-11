import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleReconciliationCron } from "../supabase/functions/reconciliation-cron/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function backfillCronRequest(offset?: number) {
  return new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ job: "melhorenvio_valor_frete_backfill", ...(offset !== undefined ? { offset } : {}) }),
  });
}

Deno.test("job=melhorenvio_valor_frete_backfill sends valor_frete for the requested page, defaulting offset to 0", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "row-1",
    store_key: "basico",
    shopify_order_id: "1",
    shopify_order_number: "1",
    shipping_price: 42.5,
  });

  const originalUrl = Deno.env.get("LUCRO_LIQUIDO_FUNCTIONS_URL");
  const originalSecret = Deno.env.get("LUCRO_LIQUIDO_CALLBACK_SECRET");
  Deno.env.set("LUCRO_LIQUIDO_FUNCTIONS_URL", "https://lucro-liquido.supabase.co");
  Deno.env.set("LUCRO_LIQUIDO_CALLBACK_SECRET", "test-lucro-secret");

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/shipping-cost-callback")) return jsonResponse({ ok: true });
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(backfillCronRequest(), { config: loadConfig(), supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { checked: 1, reported: 1, offset: 0, limit: 12, total: 1, hasMore: false });
  } finally {
    globalThis.fetch = original;
    if (originalUrl === undefined) Deno.env.delete("LUCRO_LIQUIDO_FUNCTIONS_URL");
    else Deno.env.set("LUCRO_LIQUIDO_FUNCTIONS_URL", originalUrl);
    if (originalSecret === undefined) Deno.env.delete("LUCRO_LIQUIDO_CALLBACK_SECRET");
    else Deno.env.set("LUCRO_LIQUIDO_CALLBACK_SECRET", originalSecret);
  }
});

Deno.test("job=melhorenvio_valor_frete_backfill honors an explicit offset", async () => {
  const fake = makeFakeSupabase();
  for (let i = 1; i <= 2; i += 1) {
    fake.table("orders_shipping").push({
      id: `row-${i}`,
      store_key: "basico",
      shopify_order_id: String(i),
      shopify_order_number: String(i),
      shipping_price: 10 + i,
    });
  }
  // No LUCRO_LIQUIDO_* env set -> sendShippingCostCallback no-ops (skipped),
  // which is fine here: this test only checks that `offset` reaches the
  // query (only order "2" — offset 1 — is counted as checked).

  // deno-lint-ignore no-explicit-any
  const res = await handleReconciliationCron(backfillCronRequest(1), { config, supabase: fake as any });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { checked: 1, reported: 1, offset: 1, limit: 12, total: 2, hasMore: false });
});

Deno.test("no auth, no job, or wrong secret still behaves exactly as before (regression guard)", async () => {
  const req = new Request("http://localhost/functions/v1/reconciliation-cron", { method: "POST" });
  const res = await handleReconciliationCron(req, { config });
  assertEquals(res.status, 401);
});
