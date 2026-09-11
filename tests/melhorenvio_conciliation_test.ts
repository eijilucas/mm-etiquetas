import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { fetchConciliationDifference } from "../supabase/functions/_shared/melhorenvio.ts";
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

Deno.test("returns the debit value as a positive difference", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [{ tracking: "18268300082648", conciliation: { value: 61.92, type: "debit" } }],
      }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "18268300082648"), 61.92);
    },
  );
});

Deno.test("returns a credit as a negative difference", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [{ tracking: "AD892296116BR", conciliation: { value: 5, type: "credit" } }],
      }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "AD892296116BR"), -5);
    },
  );
});

Deno.test("sums multiple conciliation entries matching the same tracking code", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [
          { tracking: "18268300082648", conciliation: { value: 61.92, type: "debit" } },
          { tracking: "18268300082648", conciliation: { value: 10, type: "credit" } },
        ],
      }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "18268300082648"), 51.92);
    },
  );
});

Deno.test("ignores results whose tracking code doesn't exactly match (fuzzy q= search)", async () => {
  await withFetchMock(
    () =>
      jsonResponse({
        data: [{ tracking: "SOME-OTHER-CODE", conciliation: { value: 61.92, type: "debit" } }],
      }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "18268300082648"), null);
    },
  );
});

Deno.test("returns null when there's no conciliation object at all (no reweigh happened)", async () => {
  await withFetchMock(
    () => jsonResponse({ data: [{ tracking: "18268300082648", conciliation: null }] }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "18268300082648"), null);
    },
  );
});

Deno.test("returns null when there's no matching order at all", async () => {
  await withFetchMock(
    () => jsonResponse({ data: [] }),
    async () => {
      assertEquals(await fetchConciliationDifference(config, "18268300082648"), null);
    },
  );
});
