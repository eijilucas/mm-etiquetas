import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  // Re-declared here (not imported) because vi.mock factories run before
  // any top-level import in this file is initialized.
  let counter = 0;
  const nextId = () => `test-id-${(counter += 1)}`;
  function flattenWhere(where: any): any {
    if (where && typeof where === "object" && "storeKey_shopifyOrderId" in where) {
      const { storeKey_shopifyOrderId, ...rest } = where;
      return { ...rest, ...storeKey_shopifyOrderId };
    }
    return where;
  }

  function matchesWhere(row: any, rawWhere: any): boolean {
    const where = flattenWhere(rawWhere);
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (condition && typeof condition === "object" && "in" in (condition as any)) {
        if (!(condition as any).in.includes(row[key])) return false;
      } else if (row[key] !== condition) {
        return false;
      }
    }
    return true;
  }
  const rows: any[] = [];
  return {
    __rows: rows,
    orderShipping: {
      async findUnique({ where }: any) {
        return rows.find((r) => matchesWhere(r, where)) ?? null;
      },
      async findUniqueOrThrow({ where }: any) {
        const row = rows.find((r) => matchesWhere(r, where));
        if (!row) throw new Error("Record not found");
        return row;
      },
      async findMany({ where }: any = {}) {
        return rows.filter((r) => matchesWhere(r, where));
      },
      async upsert({ where, create, update }: any) {
        const existing = rows.find((r) => matchesWhere(r, where));
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), status: "pending_approval", ...create };
        rows.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const row = rows.find((r) => matchesWhere(r, where));
        if (!row) throw new Error("Record not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      async updateMany({ where, data }: any) {
        const matched = rows.filter((r) => matchesWhere(r, where));
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
        return { count: matched.length };
      },
    },
  };
});

vi.mock("../src/db/prisma", () => ({ prisma: fake }));

import { upsertPendingCandidate } from "../src/db/upsertCandidate";
import type { OrderCandidate } from "../src/shopify/mapOrder";

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
    items: [{ shopifyLineItemId: 1, title: "Camiseta", sku: "CAM-1", quantity: 1, unitPrice: "150.00", grams: 300 }],
    shippingAddress: { address1: "Rua X", city: "Sao Paulo", province_code: "SP", zip: "01310-930" },
    ...overrides,
  };
}

describe("upsertPendingCandidate idempotency", () => {
  beforeEach(() => {
    fake.__rows.length = 0;
  });

  it("creates a single pending_approval row for a new order", async () => {
    await upsertPendingCandidate(makeCandidate(), "basico");
    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].status).toBe("pending_approval");
    expect(fake.__rows[0].storeKey).toBe("basico");
  });

  it("does not create a duplicate row when the same order arrives twice (duplicate webhook)", async () => {
    await upsertPendingCandidate(makeCandidate(), "basico", "webhook-event-1");
    await upsertPendingCandidate(makeCandidate({ totalPrice: "150.00" }), "basico", "webhook-event-2");

    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].shopifyOrderId).toBe("1001");
  });

  it("updates mutable fields on a second upsert instead of inserting", async () => {
    await upsertPendingCandidate(makeCandidate({ customerName: "Maria Silva" }), "basico");
    await upsertPendingCandidate(makeCandidate({ customerName: "Maria Silva Santos" }), "basico");

    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].customerName).toBe("Maria Silva Santos");
  });

  it("never resurrects a held order back into pending_approval via reconciliation/webhook upsert", async () => {
    await upsertPendingCandidate(makeCandidate(), "basico");
    fake.__rows[0].status = "held";
    fake.__rows[0].heldReason = "sem estoque fisico";

    await upsertPendingCandidate(makeCandidate(), "basico");

    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].status).toBe("held");
    expect(fake.__rows[0].heldReason).toBe("sem estoque fisico");
  });

  it("does not touch an order that already moved past pending_approval in the pipeline", async () => {
    await upsertPendingCandidate(makeCandidate(), "basico");
    fake.__rows[0].status = "cart_created";

    await upsertPendingCandidate(makeCandidate(), "basico");

    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].status).toBe("cart_created");
  });

  it("treats the same numeric shopifyOrderId from two different stores as distinct orders", async () => {
    await upsertPendingCandidate(makeCandidate(), "basico");
    await upsertPendingCandidate(makeCandidate(), "exclusivos");

    expect(fake.__rows).toHaveLength(2);
    const storeKeys = fake.__rows.map((r: any) => r.storeKey).sort();
    expect(storeKeys).toEqual(["basico", "exclusivos"]);
    expect(fake.__rows.every((r: any) => r.shopifyOrderId === "1001")).toBe(true);

    fake.__rows.find((r: any) => r.storeKey === "basico").status = "held";
    await upsertPendingCandidate(makeCandidate(), "exclusivos", "webhook-event-x");

    expect(fake.__rows).toHaveLength(2);
    expect(fake.__rows.find((r: any) => r.storeKey === "basico").status).toBe("held");
    expect(fake.__rows.find((r: any) => r.storeKey === "exclusivos").status).toBe("pending_approval");
  });
});
