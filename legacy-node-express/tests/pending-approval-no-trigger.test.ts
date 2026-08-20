import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";

const { fake, enqueueShippingJob } = vi.hoisted(() => {
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
  const fakePrisma = {
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
  return { fake: fakePrisma, enqueueShippingJob: vi.fn() };
});

vi.mock("../src/db/prisma", () => ({ prisma: fake }));
vi.mock("../src/queue/queue", () => ({
  enqueueShippingJob,
  SHIPPING_QUEUE_NAME: "shipping-pipeline",
}));

import { buildApp } from "../src/app";
import { config, getStoreByKey } from "../src/config";

const app = buildApp();
const store = getStoreByKey("test")!;

function shopifyOrderPayload() {
  return {
    id: 5001,
    order_number: 5001,
    admin_graphql_api_id: "gid://shopify/Order/5001",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "BRL",
    total_price: "199.90",
    processed_at: "2026-08-18T09:00:00Z",
    customer: { first_name: "Joao", last_name: "Souza", email: "joao@example.com" },
    shipping_address: { address1: "Rua Y", city: "Curitiba", province_code: "PR", zip: "80000-000" },
    line_items: [{ id: 1, title: "Bone", sku: "BON-1", quantity: 2, price: "99.95", grams: 150 }],
  };
}

function sign(body: string) {
  return createHmac("sha256", store.webhookSecret).update(body).digest("base64");
}

describe("pending_approval never triggers the shipping pipeline on its own", () => {
  beforeEach(() => {
    fake.__rows.length = 0;
    enqueueShippingJob.mockClear();
  });

  it("does not enqueue a shipping job when the orders/paid webhook arrives", async () => {
    const payload = JSON.stringify(shopifyOrderPayload());
    const hmac = sign(payload);

    const response = await request(app)
      .post("/webhooks/shopify/test/orders-paid")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .send(payload);

    expect(response.status).toBe(200);
    expect(fake.__rows).toHaveLength(1);
    expect(fake.__rows[0].status).toBe("pending_approval");
    expect(enqueueShippingJob).not.toHaveBeenCalled();
  });

  it("rejects the webhook and does not persist anything when the HMAC is invalid", async () => {
    const payload = JSON.stringify(shopifyOrderPayload());

    const response = await request(app)
      .post("/webhooks/shopify/test/orders-paid")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", "not-a-valid-signature")
      .send(payload);

    expect(response.status).toBe(401);
    expect(fake.__rows).toHaveLength(0);
    expect(enqueueShippingJob).not.toHaveBeenCalled();
  });

  it("does not enqueue a shipping job even when the webhook fires repeatedly (duplicate delivery)", async () => {
    const payload = JSON.stringify(shopifyOrderPayload());
    const hmac = sign(payload);

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post("/webhooks/shopify/test/orders-paid")
        .set("Content-Type", "application/json")
        .set("X-Shopify-Hmac-Sha256", hmac)
        .send(payload);
    }

    expect(fake.__rows).toHaveLength(1);
    expect(enqueueShippingJob).not.toHaveBeenCalled();
  });

  it("only enqueues the pipeline once an order is explicitly approved through the API", async () => {
    fake.__rows.push({
      id: "order-1",
      storeKey: "test",
      shopifyOrderId: "5001",
      shopifyOrderNumber: "5001",
      status: "pending_approval",
      items: [],
      shippingAddress: {},
      financialStatus: "paid",
      totalPrice: "199.90",
      currency: "BRL",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post("/api/orders/approve")
      .set("Authorization", `Bearer ${config.internalApiToken}`)
      .send({ ids: ["order-1"], approvedBy: "tester" });

    expect(response.status).toBe(200);
    expect(fake.__rows[0].status).toBe("approved");
    expect(enqueueShippingJob).toHaveBeenCalledWith("order-1");
    expect(enqueueShippingJob).toHaveBeenCalledTimes(1);
  });

  it("rejects approve/hold/pending endpoints without a valid bearer token", async () => {
    const response = await request(app).get("/api/orders/pending");
    expect(response.status).toBe(401);
  });
});
