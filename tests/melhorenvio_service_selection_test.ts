import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { pickCheapestServiceId } from "../supabase/functions/_shared/melhorenvio.ts";
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

const address = {
  postal_code: "01310-100",
  address: "Rua Teste",
  number: "100",
  district: "Centro",
  city: "Sao Paulo",
  state_abbr: "SP",
};

const payload = {
  from: address,
  to: address,
  products: [{ name: "Produto", quantity: 1, unitary_value: 100 }],
  volumes: [{ height: 10, width: 10, length: 10, weight: 1 }],
  options: { insurance_value: 100, non_commercial: true },
};

// Real production failure (order #3374): Melhor Envio's cheapest quote was
// service id 35 ("Standard" / Total Express), which quotes fine but rejects
// POST /me/cart with "A agencia e obrigatoria ao selecionar este servico"
// because it requires an options.agency_id we never send. This service must
// never be auto-selected.
Deno.test("never auto-selects a service that requires an agency_id, even when it's the cheapest quote", async () => {
  await withFetchMock(
    () =>
      jsonResponse([
        { id: 35, name: "Standard", price: "10.00", company: { id: 8, name: "Total Express" } },
        { id: 1, name: "PAC", price: "25.00", company: { id: 1, name: "Correios" } },
      ]),
    async () => {
      const serviceId = await pickCheapestServiceId(config, payload, "order-3374");
      assertEquals(serviceId, 1);
    },
  );
});

Deno.test("still picks the true cheapest quote when no agency-restricted service is present", async () => {
  await withFetchMock(
    () =>
      jsonResponse([
        { id: 1, name: "PAC", price: "25.00", company: { id: 1, name: "Correios" } },
        { id: 2, name: "SEDEX", price: "40.00", company: { id: 1, name: "Correios" } },
      ]),
    async () => {
      const serviceId = await pickCheapestServiceId(config, payload, "order-x");
      assertEquals(serviceId, 1);
    },
  );
});
