import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  let counter = 0;
  const nextId = () => `test-id-${(counter += 1)}`;
  function matchesWhere(row: any, where: any): boolean {
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

import { runShippingPipeline } from "../src/pipeline/shippingPipeline";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeApprovedOrder() {
  return {
    id: "order-happy-1",
    storeKey: "test",
    shopifyOrderId: "9001",
    shopifyOrderNumber: "9001",
    shopifyGraphqlId: "gid://shopify/Order/9001",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    customerName: "Ana Costa",
    customerEmail: "ana@example.com",
    currency: "BRL",
    totalPrice: "89.90",
    paidAt: new Date("2026-08-18T08:00:00Z"),
    items: [{ shopifyLineItemId: 1, title: "Bolsa", sku: "BOL-1", quantity: 1, unitPrice: "89.90", grams: 800 }],
    shippingAddress: {
      name: "Ana Costa",
      address1: "Rua Central, 100",
      city: "Belo Horizonte",
      province_code: "MG",
      zip: "30130-000",
      phone: "31988887777",
    },
    status: "approved",
    approvedBy: "tester",
    approvedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("happy path: approval -> cart -> purchase -> label -> tracking", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cartRequestBody: any;

  beforeEach(() => {
    fake.__rows.length = 0;
    fake.__rows.push(makeApprovedOrder());
    cartRequestBody = undefined;

    fetchMock = vi.fn(async (url: string, init: any = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;

      if (url.includes("/me/shipment/calculate")) {
        return jsonResponse([
          { id: 2, name: "SEDEX", company: { id: 1, name: "Correios" }, price: "42.10" },
          { id: 1, name: "PAC", company: { id: 1, name: "Correios" }, price: "24.50" },
          { id: 3, name: ".Package", company: { id: 2, name: "Jadlog" }, price: "0", error: "Servico indisponivel para o destino" },
        ]);
      }
      if (url.includes("/me/cart")) {
        cartRequestBody = body;
        return jsonResponse({ id: "me-cart-1", protocol: "CART-PROTO" });
      }
      if (url.includes("/me/shipment/checkout")) {
        return jsonResponse({ purchase: { id: "purchase-1", protocol: "PURCHASE-PROTO", orders: [{ id: "me-order-1", status: "posted" }] } });
      }
      if (url.includes("/me/shipment/generate")) {
        return jsonResponse({ status: "generated" });
      }
      if (url.includes("/me/shipment/print")) {
        return jsonResponse({ url: "https://melhorenvio.com.br/labels/me-order-1.pdf" });
      }
      if (url.includes("/graphql.json")) {
        if (typeof body?.query === "string" && body.query.includes("GetFulfillmentOrders")) {
          return jsonResponse({
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } }],
                },
              },
            },
          });
        }
        if (typeof body?.query === "string" && body.query.includes("FulfillmentCreateV2")) {
          return jsonResponse({
            data: {
              fulfillmentCreateV2: {
                fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [{ number: "me-order-1", url: "" }] },
                userErrors: [],
              },
            },
          });
        }
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drives the order all the way to tracking_synced and creates the Shopify fulfillment", async () => {
    await runShippingPipeline("order-happy-1");

    const order = fake.__rows[0];
    expect(order.status).toBe("tracking_synced");
    expect(cartRequestBody.service).toBe(1); // cheapest valid quote (PAC, R$24.50) beats SEDEX and the errored Jadlog quote
    expect(order.melhorEnvioCartId).toBe("me-cart-1");
    expect(order.melhorEnvioOrderId).toBe("me-order-1");
    expect(order.labelPdfUrl).toBe("https://melhorenvio.com.br/labels/me-order-1.pdf");
    expect(order.trackingCode).toBe("me-order-1");
    expect(order.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/1");
    expect(order.lastError).toBeNull();
  });

  it("never re-issues a cart or a purchase when the pipeline is re-run after completion (idempotent)", async () => {
    await runShippingPipeline("order-happy-1");
    fetchMock.mockClear();

    await runShippingPipeline("order-happy-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks with a descriptive failed status when a line item has no weight registered", async () => {
    fake.__rows[0].items = [{ shopifyLineItemId: 1, title: "Sem peso", sku: "SP-1", quantity: 1, unitPrice: "10.00", grams: 0 }];

    await runShippingPipeline("order-happy-1");

    const order = fake.__rows[0];
    expect(order.status).toBe("failed");
    expect(order.lastError).toMatch(/weight/i);
  });
});
