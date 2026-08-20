import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";
import { verifyShopifyHmac } from "../src/shopify/webhook";
import { buildApp } from "../src/app";
import { config, getStoreByKey } from "../src/config";

const store = getStoreByKey("test")!;

function sign(body: string) {
  return createHmac("sha256", store.webhookSecret).update(body).digest("base64");
}

describe("verifyShopifyHmac", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ id: 123, financial_status: "paid" });
    const hmac = sign(body);
    expect(verifyShopifyHmac(Buffer.from(body), hmac, store.webhookSecret)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ id: 123 });
    const wrongHmac = createHmac("sha256", "wrong-secret").update(body).digest("base64");
    expect(verifyShopifyHmac(Buffer.from(body), wrongHmac, store.webhookSecret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const original = JSON.stringify({ id: 123, total_price: "10.00" });
    const hmac = sign(original);
    const tampered = JSON.stringify({ id: 123, total_price: "999999.00" });
    expect(verifyShopifyHmac(Buffer.from(tampered), hmac, store.webhookSecret)).toBe(false);
  });

  it("rejects when header is missing", () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyHmac(Buffer.from(body), undefined, store.webhookSecret)).toBe(false);
  });
});

describe("webhook route store resolution", () => {
  it("returns 404 unknown_store for a storeKey not present in SHOPIFY_STORE_KEYS, without checking HMAC", async () => {
    const app = buildApp();
    const payload = JSON.stringify({ id: 1, financial_status: "paid" });

    const response = await request(app)
      .post("/webhooks/shopify/not-a-real-store/orders-paid")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", "irrelevant")
      .send(payload);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "unknown_store" });
  });
});
