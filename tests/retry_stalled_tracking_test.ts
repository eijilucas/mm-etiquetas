import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { retryStalledTracking } from "../supabase/functions/_shared/reconciliation.ts";
import { TRACKING_NOT_YET_AVAILABLE_ERROR } from "../supabase/functions/_shared/pipeline.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function pipelineSpy() {
  const calls: string[] = [];
  const fn = async (_supabase: unknown, _config: unknown, orderShippingId: string) => {
    calls.push(orderShippingId);
  };
  return { fn: fn as unknown as typeof import("../supabase/functions/_shared/pipeline.ts").runShippingPipeline, calls };
}

Deno.test("retries a failed order stuck specifically on the tracking-not-available error", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-stalled",
    status: "failed",
    last_error: TRACKING_NOT_YET_AVAILABLE_ERROR,
    melhor_envio_order_id: "me-order-1",
  });

  const spy = pipelineSpy();
  const result = await retryStalledTracking(
    // deno-lint-ignore no-explicit-any
    fake as any,
    config,
    spy.fn,
  );

  assertEquals(result, { retried: 1 });
  assertEquals(spy.calls, ["order-stalled"]);
});

Deno.test("does not retry a failed order with a different error (e.g. invalid CEP) — that needs a human", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-bad-cep",
    status: "failed",
    last_error: "Melhor Envio API error 422: O to.postal code informado é inválido",
    melhor_envio_order_id: "me-order-2",
  });

  const spy = pipelineSpy();
  const result = await retryStalledTracking(
    // deno-lint-ignore no-explicit-any
    fake as any,
    config,
    spy.fn,
  );

  assertEquals(result, { retried: 0 });
  assertEquals(spy.calls, []);
});

Deno.test("does not retry an order that isn't in failed status", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push({
    id: "order-processing",
    status: "label_generated",
    last_error: null,
    melhor_envio_order_id: "me-order-3",
  });

  const spy = pipelineSpy();
  const result = await retryStalledTracking(
    // deno-lint-ignore no-explicit-any
    fake as any,
    config,
    spy.fn,
  );

  assertEquals(result, { retried: 0 });
  assertEquals(spy.calls, []);
});
