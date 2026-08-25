import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { estimateShippingCost } from "../supabase/functions/_shared/pipeline.ts";
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

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-est-1",
    items: [{ shopifyLineItemId: 1, title: "Camiseta", variantTitle: null, sku: "CAM-1", quantity: 1, unitPrice: "89.90", grams: 300 }],
    shipping_address: { zip: "01310-930", address1: "Av. Paulista, 1000", city: "Sao Paulo", province_code: "SP" },
    ...overrides,
  };
}

Deno.test("returns the cheapest valid quote's price", async () => {
  await withFetchMock(
    () =>
      jsonResponse([
        { id: 1, name: "PAC", company: { id: 1, name: "Correios" }, price: "24.50" },
        { id: 2, name: "SEDEX", company: { id: 1, name: "Correios" }, price: "42.10" },
      ]),
    async () => {
      // deno-lint-ignore no-explicit-any
      assertEquals(await estimateShippingCost(config, makeOrder() as any), 24.5);
    },
  );
});

Deno.test("skips errored/zero quotes and picks the cheapest of what's left", async () => {
  await withFetchMock(
    () =>
      jsonResponse([
        { id: 3, name: ".Package", company: { id: 2, name: "Jadlog" }, price: "0", error: "Servico indisponivel" },
        { id: 1, name: "PAC", company: { id: 1, name: "Correios" }, price: "24.50" },
      ]),
    async () => {
      // deno-lint-ignore no-explicit-any
      assertEquals(await estimateShippingCost(config, makeOrder() as any), 24.5);
    },
  );
});

Deno.test("returns null instead of throwing when no valid quote comes back", async () => {
  await withFetchMock(
    () => jsonResponse([{ id: 3, name: ".Package", price: "0", error: "Servico indisponivel" }]),
    async () => {
      // deno-lint-ignore no-explicit-any
      assertEquals(await estimateShippingCost(config, makeOrder() as any), null);
    },
  );
});

Deno.test("returns null instead of throwing when Melhor Envio's API errors out", async () => {
  await withFetchMock(
    () => jsonResponse({ message: "erro" }, 500),
    async () => {
      // deno-lint-ignore no-explicit-any
      assertEquals(await estimateShippingCost(config, makeOrder() as any), null);
    },
  );
});

Deno.test("returns null when the order has no postal code to quote against", async () => {
  const order = makeOrder({ shipping_address: { address1: "Sem CEP" } });
  // deno-lint-ignore no-explicit-any
  assertEquals(await estimateShippingCost(config, order as any), null);
});
