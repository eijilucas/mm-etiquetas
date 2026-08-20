import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { verifyShopifyHmac } from "../supabase/functions/_shared/shopify.ts";

const secret = "test-webhook-secret";

async function sign(body: string, key = secret): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test("verifyShopifyHmac accepts a correctly signed body", async () => {
  const body = JSON.stringify({ id: 123, financial_status: "paid" });
  const hmac = await sign(body);
  assertEquals(await verifyShopifyHmac(new TextEncoder().encode(body), hmac, secret), true);
});

Deno.test("verifyShopifyHmac rejects a body signed with the wrong secret", async () => {
  const body = JSON.stringify({ id: 123 });
  const wrongHmac = await sign(body, "wrong-secret");
  assertEquals(await verifyShopifyHmac(new TextEncoder().encode(body), wrongHmac, secret), false);
});

Deno.test("verifyShopifyHmac rejects a tampered body", async () => {
  const original = JSON.stringify({ id: 123, total_price: "10.00" });
  const hmac = await sign(original);
  const tampered = JSON.stringify({ id: 123, total_price: "999999.00" });
  assertEquals(await verifyShopifyHmac(new TextEncoder().encode(tampered), hmac, secret), false);
});

Deno.test("verifyShopifyHmac rejects when header is missing", async () => {
  const body = JSON.stringify({ id: 123 });
  assertEquals(await verifyShopifyHmac(new TextEncoder().encode(body), undefined, secret), false);
});

Deno.test("shopify-webhook route resolution: returns 404 unknown_store for an unconfigured storeKey, without checking HMAC", async () => {
  const { handleShopifyWebhook } = await import("../supabase/functions/shopify-webhook/index.ts");
  const req = new Request("http://localhost/functions/v1/shopify-webhook/not-a-real-store", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": "irrelevant" },
    body: JSON.stringify({ id: 1, financial_status: "paid" }),
  });
  const res = await handleShopifyWebhook(req);
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "unknown_store" });
});
