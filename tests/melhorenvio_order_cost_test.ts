import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { fetchOrderCostByMelhorEnvioId } from "../supabase/functions/_shared/melhorenvio.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withFetchMock(handler: () => Promise<Response> | Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => await handler()) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test("returns the purchase price, no conciliation", async () => {
  await withFetchMock(
    () => jsonResponse({ data: [{ id: "me-order-1", price: 25.04, conciliation: null }] }),
    async () => {
      assertEquals(await fetchOrderCostByMelhorEnvioId(config, "me-order-1"), { price: 25.04, conciliationValue: null });
    },
  );
});

Deno.test("also picks up a conciliation debit for free, same as fetchConciliationDifference", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [{ id: "me-order-1", price: 25.04, conciliation: { value: 61.92, type: "debit" } }],
      }),
    async () => {
      assertEquals(await fetchOrderCostByMelhorEnvioId(config, "me-order-1"), { price: 25.04, conciliationValue: 61.92 });
    },
  );
});

Deno.test("a conciliation credit comes back negative", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [{ id: "me-order-1", price: 25.04, conciliation: { value: 5, type: "credit" } }],
      }),
    async () => {
      assertEquals(await fetchOrderCostByMelhorEnvioId(config, "me-order-1"), { price: 25.04, conciliationValue: -5 });
    },
  );
});

Deno.test("ignores a fuzzy-search result whose id doesn't exactly match", async () => {
  await withFetchMock(
    () => jsonResponse({ data: [{ id: "some-other-order", price: 25.04, conciliation: null }] }),
    async () => {
      assertEquals(await fetchOrderCostByMelhorEnvioId(config, "me-order-1"), null);
    },
  );
});

Deno.test("returns null when there's no match at all", async () => {
  await withFetchMock(
    () => jsonResponse({ data: [] }),
    async () => {
      assertEquals(await fetchOrderCostByMelhorEnvioId(config, "me-order-1"), null);
    },
  );
});
