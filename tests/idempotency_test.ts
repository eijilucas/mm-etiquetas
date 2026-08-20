import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { upsertPendingCandidate } from "../supabase/functions/_shared/db.ts";
import type { OrderCandidate } from "../supabase/functions/_shared/shopify.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

function makeCandidate(overrides: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    shopifyOrderId: "1001",
    shopifyOrderNumber: "1001",
    shopifyGraphqlId: "gid://shopify/Order/1001",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    customerName: "Maria Silva",
    customerEmail: "maria@example.com",
    currency: "BRL",
    totalPrice: "150.00",
    paidAt: new Date("2026-08-18T10:00:00Z"),
    items: [{ shopifyLineItemId: 1, title: "Camiseta", variantTitle: null, sku: "CAM-1", quantity: 1, unitPrice: "150.00", grams: 300 }],
    shippingAddress: { address1: "Rua X", city: "Sao Paulo", province_code: "SP", zip: "01310-930" },
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
function client(fake: ReturnType<typeof makeFakeSupabase>): any {
  return fake;
}

Deno.test("creates a single pending_approval row for a new order", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");
  const rows = fake.table("orders_shipping");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "pending_approval");
  assertEquals(rows[0].store_key, "basico");
});

Deno.test("does not create a duplicate row when the same order arrives twice (duplicate webhook)", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate(), "basico", "webhook-event-1");
  await upsertPendingCandidate(client(fake), makeCandidate({ totalPrice: "150.00" }), "basico", "webhook-event-2");

  const rows = fake.table("orders_shipping");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].shopify_order_id, "1001");
});

Deno.test("updates mutable fields on a second upsert instead of inserting", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate({ customerName: "Maria Silva" }), "basico");
  await upsertPendingCandidate(client(fake), makeCandidate({ customerName: "Maria Silva Santos" }), "basico");

  const rows = fake.table("orders_shipping");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].customer_name, "Maria Silva Santos");
});

Deno.test("never resurrects a held order back into pending_approval via reconciliation/webhook upsert", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");
  const rows = fake.table("orders_shipping");
  rows[0].status = "held";
  rows[0].held_reason = "sem estoque fisico";

  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");

  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "held");
  assertEquals(rows[0].held_reason, "sem estoque fisico");
});

Deno.test("does not touch an order that already moved past pending_approval in the pipeline", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");
  const rows = fake.table("orders_shipping");
  rows[0].status = "cart_created";

  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");

  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "cart_created");
});

Deno.test("treats the same numeric shopifyOrderId from two different stores as distinct orders", async () => {
  const fake = makeFakeSupabase();
  await upsertPendingCandidate(client(fake), makeCandidate(), "basico");
  await upsertPendingCandidate(client(fake), makeCandidate(), "exclusivos");

  const rows = fake.table("orders_shipping");
  assertEquals(rows.length, 2);
  const storeKeys = rows.map((r) => r.store_key as string).sort();
  assertEquals(storeKeys, ["basico", "exclusivos"]);
  assertEquals(rows.every((r) => r.shopify_order_id === "1001"), true);

  const basicoRow = rows.find((r) => r.store_key === "basico")!;
  basicoRow.status = "held";
  await upsertPendingCandidate(client(fake), makeCandidate(), "exclusivos", "webhook-event-x");

  assertEquals(rows.length, 2);
  assertEquals(rows.find((r) => r.store_key === "basico")!.status, "held");
  assertEquals(rows.find((r) => r.store_key === "exclusivos")!.status, "pending_approval");
});
