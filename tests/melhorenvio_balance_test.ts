import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { fetchAccountBalance } from "../supabase/functions/_shared/melhorenvio.ts";
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

Deno.test("reads a flat numeric balance from GET /me/balance", async () => {
  await withFetchMock(
    () => jsonResponse({ balance: 1234.56 }),
    async () => {
      assertEquals(await fetchAccountBalance(config), 1234.56);
    },
  );
});

Deno.test("reads balance nested under an 'available' field", async () => {
  await withFetchMock(
    () => jsonResponse({ balance: { available: "42.10" } }),
    async () => {
      assertEquals(await fetchAccountBalance(config), 42.1);
    },
  );
});

Deno.test("returns null instead of throwing when the token lacks permission (403)", async () => {
  await withFetchMock(
    () => jsonResponse({ message: "This action is unauthorized." }, 403),
    async () => {
      assertEquals(await fetchAccountBalance(config), null);
    },
  );
});

Deno.test("returns null when the response has no recognizable balance field", async () => {
  await withFetchMock(
    () => jsonResponse({ unexpected: "shape" }),
    async () => {
      assertEquals(await fetchAccountBalance(config), null);
    },
  );
});
