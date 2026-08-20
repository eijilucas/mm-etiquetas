import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { reportLabelGenerated, reportLabelCancelled } from "../supabase/functions/_shared/estoque.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";

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

function withEstoqueConfigured<T>(fn: () => T): T {
  const prevUrl = Deno.env.get("ESTOQUE_API_URL");
  const prevSecret = Deno.env.get("ESTOQUE_INTEGRATION_SECRET");
  Deno.env.set("ESTOQUE_API_URL", "https://mental-estoque.vercel.app");
  Deno.env.set("ESTOQUE_INTEGRATION_SECRET", "test-estoque-secret");
  try {
    return fn();
  } finally {
    if (prevUrl === undefined) Deno.env.delete("ESTOQUE_API_URL");
    else Deno.env.set("ESTOQUE_API_URL", prevUrl);
    if (prevSecret === undefined) Deno.env.delete("ESTOQUE_INTEGRATION_SECRET");
    else Deno.env.set("ESTOQUE_INTEGRATION_SECRET", prevSecret);
  }
}

const items = [
  { shopifyLineItemId: 111, title: "Calça", variantTitle: "M", sku: "CAL-M", quantity: 2, unitPrice: "250.00", grams: 0 },
];

Deno.test("reportLabelGenerated posts shopifyOrderId + items with the bearer secret when configured", async () => {
  await withEstoqueConfigured(() =>
    withFetchMock(
      (url, init) => {
        assertEquals(url, "https://mental-estoque.vercel.app/api/mm-etiquetas/label-generated");
        assertEquals(init.headers && (init.headers as Record<string, string>).Authorization, "Bearer test-estoque-secret");
        const body = JSON.parse(init.body as string);
        assertEquals(body, { shopifyOrderId: 7622037864686, items: [{ shopifyLineItemId: 111, quantity: 2 }] });
        return jsonResponse({ ok: true });
      },
      () => reportLabelGenerated(loadConfig(), "7622037864686", items),
    ),
  );
});

Deno.test("reportLabelCancelled posts to the label-cancelled endpoint", async () => {
  await withEstoqueConfigured(() =>
    withFetchMock(
      (url) => {
        assertEquals(url, "https://mental-estoque.vercel.app/api/mm-etiquetas/label-cancelled");
        return jsonResponse({ ok: true });
      },
      () => reportLabelCancelled(loadConfig(), "7622037864686", items),
    ),
  );
});

Deno.test("swallows a non-2xx response instead of throwing (best-effort)", async () => {
  await withEstoqueConfigured(() =>
    withFetchMock(
      () => jsonResponse({ error: "internal_error" }, 500),
      async () => {
        // Would throw and fail the test if reportLabelGenerated propagated the error.
        await reportLabelGenerated(loadConfig(), "7622037864686", items);
      },
    ),
  );
});

Deno.test("swallows a network error instead of throwing (best-effort)", async () => {
  await withEstoqueConfigured(() =>
    withFetchMock(
      () => {
        throw new Error("network down");
      },
      async () => {
        await reportLabelGenerated(loadConfig(), "7622037864686", items);
      },
    ),
  );
});

Deno.test("does not call fetch at all when ESTOQUE_API_URL/SECRET are unset", async () => {
  let calls = 0;
  await withFetchMock(
    () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
    () => reportLabelGenerated(loadConfig(), "7622037864686", items),
  );
  assertEquals(calls, 0);
});
