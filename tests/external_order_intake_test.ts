import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { makeFakeSupabase } from "./fake_supabase.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";

Deno.env.set("EXTERNAL_ORDERS_SECRET", "test-external-orders-secret");

const { handleExternalOrderIntake } = await import("../supabase/functions/external-order-intake/index.ts");

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    externalOrderId: "aaaaaaaa-0000-0000-0000-000000000001",
    publicNumber: 1048,
    customerName: "Maria Silva",
    customerEmail: "maria@example.com",
    customerDocument: "11144477735",
    customerPhone: "16999998888",
    totalPrice: "259.99",
    address: {
      street: "Rua Exemplo",
      number: "100",
      complement: "casa",
      district: "Jardim Exemplo",
      city: "Ribeirao Preto",
      state: "SP",
      cep: "14169310",
    },
    items: [
      {
        itemId: "item-1",
        title: "Calça Oversized - Hell Hounds Drop",
        productId: "shopify-10799740682552",
        size: "M",
        color: null,
        quantity: 1,
        unitPrice: "259.99",
      },
    ],
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
function client(fake: ReturnType<typeof makeFakeSupabase>): any {
  return fake;
}

function req(body: unknown, secret = "test-external-orders-secret") {
  return new Request("http://localhost/functions/v1/external-order-intake", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

Deno.test("creates a pending_approval row with store_key external", async () => {
  const fake = makeFakeSupabase();
  const res = await handleExternalOrderIntake(req(makeBody()), { config: loadConfig(), supabase: client(fake) });
  assertEquals(res.status, 200);

  const rows = fake.table("orders_shipping");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].store_key, "external");
  assertEquals(rows[0].shopify_order_id, "aaaaaaaa-0000-0000-0000-000000000001");
  assertEquals(rows[0].status, "pending_approval");
  assertEquals(rows[0].shopify_order_number, "VE-1048");
  const address = rows[0].shipping_address as Record<string, unknown>;
  assertEquals(address.address1, "Rua Exemplo, 100");
  assertEquals(address.document, "11144477735");
});

Deno.test("rejects without the correct secret", async () => {
  const fake = makeFakeSupabase();
  const res = await handleExternalOrderIntake(req(makeBody(), "wrong-secret"), {
    config: loadConfig(),
    supabase: client(fake),
  });
  assertEquals(res.status, 401);
  assertEquals(fake.table("orders_shipping").length, 0);
});

Deno.test("rejects when required fields are missing", async () => {
  const fake = makeFakeSupabase();
  const res = await handleExternalOrderIntake(req(makeBody({ customerDocument: undefined })), {
    config: loadConfig(),
    supabase: client(fake),
  });
  assertEquals(res.status, 400);
});

Deno.test("does not duplicate the row when the same external order is sent twice", async () => {
  const fake = makeFakeSupabase();
  await handleExternalOrderIntake(req(makeBody()), { config: loadConfig(), supabase: client(fake) });
  await handleExternalOrderIntake(req(makeBody()), { config: loadConfig(), supabase: client(fake) });

  assertEquals(fake.table("orders_shipping").length, 1);
});

Deno.test("held external order is never resurrected back into pending_approval", async () => {
  const fake = makeFakeSupabase();
  await handleExternalOrderIntake(req(makeBody()), { config: loadConfig(), supabase: client(fake) });
  const rows = fake.table("orders_shipping");
  rows[0].status = "held";
  rows[0].held_reason = "endereco incompleto";

  await handleExternalOrderIntake(req(makeBody()), { config: loadConfig(), supabase: client(fake) });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "held");
});
