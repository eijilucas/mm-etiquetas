import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { fetchTrackingByOrderId, fetchTrackingBatch } from "../supabase/functions/_shared/melhorenvio.ts";
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

Deno.test("prefers the raw carrier tracking code when Melhor Envio has it", async () => {
  await withFetchMock(
    () => jsonResponse({ "me-1": { id: "me-1", tracking: "AA123456785BR", melhorenvio_tracking: "ME262CMAHI0BR" } }),
    async () => {
      assertEquals(await fetchTrackingByOrderId(config, "me-1"), "AA123456785BR");
    },
  );
});

// Regression: some carriers (observed on Jadlog) leave `tracking` null for a
// long time even though Melhor Envio already generated its own trackable
// code — syncTrackingStep was treating that as "not available yet" and
// throwing forever instead of using the code that's actually usable.
Deno.test("falls back to melhorenvio_tracking when the carrier hasn't assigned its own code yet", async () => {
  await withFetchMock(
    () => jsonResponse({ "me-1": { id: "me-1", tracking: null, melhorenvio_tracking: "ME262CMAHI0BR" } }),
    async () => {
      assertEquals(await fetchTrackingByOrderId(config, "me-1"), "ME262CMAHI0BR");
    },
  );
});

Deno.test("returns undefined when neither tracking field is set yet", async () => {
  await withFetchMock(
    () => jsonResponse({ "me-1": { id: "me-1", tracking: null, melhorenvio_tracking: null } }),
    async () => {
      assertEquals(await fetchTrackingByOrderId(config, "me-1"), undefined);
    },
  );
});

// Regression: ME 422s the whole /me/shipment/tracking request if any single
// id in the list is malformed. One bad melhor_envio_order_id used to kill
// the entire posted-status sync. fetchTrackingBatch must drop empty ids and
// isolate a still-failing id instead of losing every other order.
Deno.test("fetchTrackingBatch drops empty ids and isolates one bad id, keeping the rest", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const orders = JSON.parse(init?.body as string).orders as string[];
    if (orders.includes("bad")) {
      return jsonResponse({ message: "O campo orders.N deve ter pelo menos 36 caracteres." }, 422);
    }
    return jsonResponse(Object.fromEntries(orders.map((id) => [id, { id, status: "received" }])));
  }) as typeof fetch;

  try {
    const result = await fetchTrackingBatch(config, ["good-1", "", "bad", "good-2", "  "]);
    assertEquals(Object.keys(result).sort(), ["good-1", "good-2"]);
    assertEquals(result["good-1"].status, "received");
  } finally {
    globalThis.fetch = original;
  }
});
