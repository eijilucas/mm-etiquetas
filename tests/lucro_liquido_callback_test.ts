import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { reportShippingCost } from "../supabase/functions/_shared/lucroLiquidoCallback.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";

type Order = Parameters<typeof reportShippingCost>[1];

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    store_key: "basico",
    shopify_order_id: "5834923000001",
    shopify_order_number: "3511",
    shipping_price: 27.9,
    ...overrides,
  };
}

function withFetchMock<T>(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
  run: (calls: Array<{ url: string; body: unknown; signature: string | null }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ url: string; body: unknown; signature: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      signature: (init?.headers as Record<string, string>)?.["X-Signature"] ?? null,
    });
    return handler(input, init);
  }) as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }
  return run().finally(() => {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

Deno.test("reportShippingCost: POST assinado com shopify_order_id / valor_frete / order_number quando configurado", async () => {
  await withEnv(
    {
      LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
      LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
    },
    () =>
      withFetchMock(
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        async (calls) => {
          const config = loadConfig();
          await reportShippingCost(config, makeOrder());

          assertEquals(calls.length, 1);
          assertEquals(
            calls[0].url,
            "https://lucro-liquido.supabase.co/functions/v1/shipping-cost-callback",
          );
          assertEquals(calls[0].body, {
            shopify_order_id: "5834923000001",
            valor_frete: 27.9,
            order_number: "3511",
          });
          assertEquals((calls[0].signature ?? "").length, 64); // hex SHA-256
        },
      ),
  );
});

Deno.test("reportShippingCost: no-op silencioso quando LUCRO_LIQUIDO_CALLBACK_SECRET nao esta setado", async () => {
  await withEnv({ LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co" }, () =>
    withFetchMock(
      () => new Response("{}", { status: 200 }),
      async (calls) => {
        const config = loadConfig();
        await reportShippingCost(config, makeOrder());
        assertEquals(calls.length, 0);
      },
    ),
  );
});

Deno.test("reportShippingCost: pedido externo manda external_order_id em vez de shopify_order_id", async () => {
  await withEnv(
    {
      LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
      LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
    },
    () =>
      withFetchMock(
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        async (calls) => {
          const config = loadConfig();
          await reportShippingCost(
            config,
            makeOrder({ store_key: "external", shopify_order_id: "b3b8c1e2-uuid" }),
          );
          assertEquals(calls.length, 1);
          assertEquals(calls[0].body, {
            external_order_id: "b3b8c1e2-uuid",
            valor_frete: 27.9,
            order_number: "3511",
          });
        },
      ),
  );
});

Deno.test("reportShippingCost: pula pedido sem shipping_price (rastreio manual)", async () => {
  await withEnv(
    {
      LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
      LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
    },
    () =>
      withFetchMock(
        () => new Response("{}", { status: 200 }),
        async (calls) => {
          const config = loadConfig();
          await reportShippingCost(config, makeOrder({ shipping_price: null }));
          assertEquals(calls.length, 0);
        },
      ),
  );
});

Deno.test("reportShippingCost: falha permanente do callback nao propaga (best-effort)", async () => {
  await withEnv(
    {
      LUCRO_LIQUIDO_FUNCTIONS_URL: "https://lucro-liquido.supabase.co",
      LUCRO_LIQUIDO_CALLBACK_SECRET: "test-lucro-secret",
    },
    () =>
      withFetchMock(
        () => new Response("erro interno", { status: 500 }),
        async (calls) => {
          const config = loadConfig();
          await reportShippingCost(config, makeOrder()); // nao deve lancar
          assertEquals(calls.length, 3); // withRetry: 3 tentativas
        },
      ),
  );
});
