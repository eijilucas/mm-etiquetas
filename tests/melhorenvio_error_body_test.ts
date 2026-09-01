import "./test_env.ts";
import { assertStringIncludes } from "jsr:@std/assert@1";
import { addToCart } from "../supabase/functions/_shared/melhorenvio.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import type { MeCartRequest } from "../supabase/functions/_shared/melhorenvio.ts";

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

const minimalCartRequest = {} as MeCartRequest;

// describeErrorBody previously only looked at body.message and body.errors —
// a body shaped any other way (a differently-named field, here) silently
// collapsed into the useless "sem detalhes na resposta", with the real
// detail Melhor Envio actually sent thrown away. It's the only record of
// that failure once the response is handled, so losing it here means it's
// gone for good.
Deno.test("surfaces the raw body when neither message nor errors is present", async () => {
  await withFetchMock(
    () => jsonResponse({ reason: "Endereco invalido para esse CEP" }, 422),
    async () => {
      try {
        await addToCart(config, minimalCartRequest);
        throw new Error("expected addToCart to throw");
      } catch (error) {
        const message = (error as Error).message;
        assertStringIncludes(message, "corpo bruto");
        assertStringIncludes(message, "Endereco invalido para esse CEP");
      }
    },
  );
});

Deno.test("still reports the plain message when the body has one", async () => {
  await withFetchMock(
    () => jsonResponse({ message: "CEP nao atendido" }, 422),
    async () => {
      try {
        await addToCart(config, minimalCartRequest);
        throw new Error("expected addToCart to throw");
      } catch (error) {
        const message = (error as Error).message;
        assertStringIncludes(message, "CEP nao atendido");
      }
    },
  );
});

Deno.test("falls back to the generic message when the body is truly empty", async () => {
  await withFetchMock(
    () => new Response("", { status: 422, headers: { "Content-Type": "application/json" } }),
    async () => {
      try {
        await addToCart(config, minimalCartRequest);
        throw new Error("expected addToCart to throw");
      } catch (error) {
        const message = (error as Error).message;
        assertStringIncludes(message, "sem detalhes na resposta");
      }
    },
  );
});
