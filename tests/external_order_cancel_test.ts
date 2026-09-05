import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { makeFakeSupabase } from "./fake_supabase.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";

Deno.env.set("EXTERNAL_ORDERS_SECRET", "test-external-orders-secret");

const { handleExternalOrderIntake } = await import("../supabase/functions/external-order-intake/index.ts");

// deno-lint-ignore no-explicit-any
function client(fake: ReturnType<typeof makeFakeSupabase>): any {
  return fake;
}

function req(body: unknown, secret = "test-external-orders-secret") {
  return new Request("http://localhost/functions/v1/external-order-intake", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    store_key: "external",
    shopify_order_id: "ve-order-1",
    status: "pending_approval",
    ...overrides,
  };
}

Deno.test("cancela (DELETE): pedido não encontrado responde ok com found:false, sem erro", async () => {
  const fake = makeFakeSupabase();
  const res = await handleExternalOrderIntake(req({ externalOrderId: "nao-existe" }), {
    config: loadConfig(),
    supabase: client(fake),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, found: false });
});

Deno.test("cancela (DELETE): rejeita sem o secret certo", async () => {
  const fake = makeFakeSupabase();
  const res = await handleExternalOrderIntake(req({ externalOrderId: "ve-order-1" }, "wrong-secret"), {
    config: loadConfig(),
    supabase: client(fake),
  });
  assertEquals(res.status, 401);
});

Deno.test("cancela (DELETE): pending_approval vai direto pra archived, sem passar por held", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeRow());

  const res = await handleExternalOrderIntake(req({ externalOrderId: "ve-order-1" }), {
    config: loadConfig(),
    supabase: client(fake),
  });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, found: true, finalStatus: "archived" });
  const row = fake.table("orders_shipping")[0];
  assertEquals(row.status, "archived");
  assertEquals(row.archived_by, "vendas-externas-sync");
});

Deno.test("cancela (DELETE): held também vai direto pra archived", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeRow({ status: "held", held_reason: "endereco incompleto" }));

  await handleExternalOrderIntake(req({ externalOrderId: "ve-order-1" }), { config: loadConfig(), supabase: client(fake) });

  assertEquals(fake.table("orders_shipping")[0].status, "archived");
});

Deno.test("cancela (DELETE): já arquivado responde ok idempotente, sem reprocessar", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeRow({ status: "archived", archived_at: "2026-08-01T00:00:00Z", archived_by: "vitor@m3ntalmadness.com" }));

  const res = await handleExternalOrderIntake(req({ externalOrderId: "ve-order-1" }), {
    config: loadConfig(),
    supabase: client(fake),
  });

  assertEquals(await res.json(), { ok: true, found: true, finalStatus: "archived", already: true });
  // Não sobrescreve quem arquivou originalmente.
  assertEquals(fake.table("orders_shipping")[0].archived_by, "vitor@m3ntalmadness.com");
});

Deno.test("cancela (DELETE): pedido em processamento (sem compra na Melhor Envio ainda) passa por cancelOrderLabel e termina archived", async () => {
  const fake = makeFakeSupabase();
  // "approved" sem melhor_envio_order_id: cancelOrderLabel toma o atalho
  // que só marca held sem chamar a Melhor Envio (ver pipeline.ts) — não
  // precisa mockar fetch pra esse caso.
  fake.table("orders_shipping").push(makeRow({ status: "approved", melhor_envio_order_id: null, items: [] }));

  const res = await handleExternalOrderIntake(req({ externalOrderId: "ve-order-1" }), {
    config: loadConfig(),
    supabase: client(fake),
  });

  assertEquals(res.status, 200);
  const row = fake.table("orders_shipping")[0];
  assertEquals(row.status, "archived");
});
