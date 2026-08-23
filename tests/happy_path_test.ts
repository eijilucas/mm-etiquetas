import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { runShippingPipeline, cancelOrderLabel } from "../supabase/functions/_shared/pipeline.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeApprovedOrder() {
  return {
    id: "order-happy-1",
    store_key: "test",
    shopify_order_id: "9001",
    shopify_order_number: "9001",
    shopify_graphql_id: "gid://shopify/Order/9001",
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    customer_name: "Ana Costa",
    customer_email: "ana@example.com",
    currency: "BRL",
    total_price: "89.90",
    paid_at: "2026-08-18T08:00:00Z",
    items: [{ shopifyLineItemId: 1, title: "Bolsa", variantTitle: null, sku: "BOL-1", quantity: 1, unitPrice: "89.90", grams: 800 }],
    shipping_address: {
      name: "Ana Costa",
      address1: "Rua Central, 100",
      city: "Belo Horizonte",
      province_code: "MG",
      zip: "30130-000",
      phone: "31988887777",
      document: "12345678900",
    },
    status: "approved",
    approved_by: "tester",
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function withFetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  let calls = 0;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init ?? {});
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  return fn().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

function meAndShopifyHandler() {
  return (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;

    if (url.includes("/me/shipment/calculate")) {
      return jsonResponse([
        { id: 2, name: "SEDEX", company: { id: 1, name: "Correios" }, price: "42.10" },
        { id: 1, name: "PAC", company: { id: 1, name: "Correios" }, price: "24.50" },
        { id: 3, name: ".Package", company: { id: 2, name: "Jadlog" }, price: "0", error: "Servico indisponivel para o destino" },
      ]);
    }
    if (url.includes("/me/cart")) {
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
    if (url.includes("/me/shipment/tracking")) {
      return jsonResponse({ "me-order-1": { id: "me-order-1", status: "posted", tracking: "ME23002OWZ7BR" } });
    }
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test-fetched", scope: "read_orders,write_fulfillments", expires_in: 86399 });
    }
    if (url.includes("/graphql.json")) {
      if (typeof body?.query === "string" && body.query.includes("GetLocalizationExtensions")) {
        return jsonResponse({
          data: { order: { localizationExtensions: { edges: [] } } },
        });
      }
      if (typeof body?.query === "string" && body.query.includes("GetFulfillmentOrders")) {
        return jsonResponse({
          data: { order: { fulfillmentOrders: { edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } }] } } },
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
  };
}

Deno.test("drives the order all the way to tracking_synced and creates the Shopify fulfillment", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeApprovedOrder());
  let cartRequestBody: { service?: number } | undefined;

  await withFetchMock(
    (url, init) => {
      if (url.includes("/me/cart")) {
        cartRequestBody = JSON.parse(init.body as string);
      }
      return meAndShopifyHandler()(url, init);
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, config, "order-happy-1"),
  );

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "tracking_synced");
  assertEquals(cartRequestBody?.service, 1); // cheapest valid quote (PAC, R$24.50) beats SEDEX and the errored Jadlog quote
  assertEquals(order.melhor_envio_cart_id, "me-cart-1");
  assertEquals(order.melhor_envio_order_id, "me-order-1");
  assertEquals(order.label_pdf_url, "https://melhorenvio.com.br/labels/me-order-1.pdf");
  assertEquals(order.tracking_code, "ME23002OWZ7BR");
  assertEquals(order.shopify_fulfillment_id, "gid://shopify/Fulfillment/1");
  assertEquals(order.last_error, null);
});

Deno.test("never re-issues a cart or a purchase when the pipeline is re-run after completion (idempotent)", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeApprovedOrder());

  await withFetchMock(meAndShopifyHandler(), () =>
    // deno-lint-ignore no-explicit-any
    runShippingPipeline(fake as any, config, "order-happy-1"));

  let secondRunCalls = 0;
  await withFetchMock(
    () => {
      secondRunCalls += 1;
      throw new Error("fetch should not be called on a completed order");
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, config, "order-happy-1"),
  );

  assertEquals(secondRunCalls, 0);
});

Deno.test("uses the single-item volume estimate (2x20x20cm, 0.5kg) for a 1-quantity order, ignoring Shopify's grams", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.items = [{ shopifyLineItemId: 1, title: "Camiseta", variantTitle: null, sku: "SP-1", quantity: 1, unitPrice: "89.90", grams: 0 }];
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "tracking_synced");
  assertEquals(cartRequestBody.volumes, [{ height: 2, width: 20, length: 20, weight: 0.5 }]);
});

Deno.test("uses the multi-item volume estimate (2x40x40cm, 1kg) once total quantity is 2 or more", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.items = [
    { shopifyLineItemId: 1, title: "Camiseta", variantTitle: null, sku: "SP-1", quantity: 1, unitPrice: "89.90", grams: 0 },
    { shopifyLineItemId: 2, title: "Calca", variantTitle: null, sku: "SP-1", quantity: 1, unitPrice: "150.00", grams: 0 },
  ];
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "tracking_synced");
  assertEquals(cartRequestBody.volumes, [{ height: 2, width: 40, length: 40, weight: 1 }]);
});

Deno.test("declares a fixed R$250/item value (not the real Shopify price) for both products and insurance", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.items = [
    { shopifyLineItemId: 1, title: "Bolsa cara", variantTitle: null, sku: "BOL-1", quantity: 1, unitPrice: "899.90", grams: 800 },
    { shopifyLineItemId: 2, title: "Carteira", variantTitle: null, sku: "CAR-1", quantity: 2, unitPrice: "199.90", grams: 200 },
  ];
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.products, [
    { name: "Bolsa cara", quantity: 1, unitary_value: 250 },
    { name: "Carteira", quantity: 2, unitary_value: 250 },
  ]);
  assertEquals(cartRequestBody.options.insurance_value, 750); // 250 * 3 total items, not the real R$1299.70
});

Deno.test("reports the label to mental-madness-estoque right after it's generated, without blocking the pipeline if that call fails", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeApprovedOrder());

  const prevUrl = Deno.env.get("ESTOQUE_API_URL");
  const prevSecret = Deno.env.get("ESTOQUE_INTEGRATION_SECRET");
  Deno.env.set("ESTOQUE_API_URL", "https://mental-estoque.vercel.app");
  Deno.env.set("ESTOQUE_INTEGRATION_SECRET", "test-estoque-secret");
  const estoqueConfig = loadConfig();
  if (prevUrl === undefined) Deno.env.delete("ESTOQUE_API_URL");
  else Deno.env.set("ESTOQUE_API_URL", prevUrl);
  if (prevSecret === undefined) Deno.env.delete("ESTOQUE_INTEGRATION_SECRET");
  else Deno.env.set("ESTOQUE_INTEGRATION_SECRET", prevSecret);

  let estoqueCallBody: any;
  await withFetchMock(
    (url, init) => {
      if (url === "https://mental-estoque.vercel.app/api/mm-etiquetas/label-generated") {
        estoqueCallBody = JSON.parse(init.body as string);
        return jsonResponse({ error: "internal_error" }, 500); // failure must not block the pipeline
      }
      return meAndShopifyHandler()(url, init);
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, estoqueConfig, "order-happy-1"),
  );

  assertEquals(estoqueCallBody, {
    shopifyOrderId: 9001,
    items: [{ shopifyLineItemId: 1, quantity: 1 }],
  });
  assertEquals(fake.table("orders_shipping")[0].status, "tracking_synced"); // 500 from estoque didn't stall the order
});

Deno.test("splits the house number out of address1 instead of always sending S/N (Shopify has no dedicated number field)", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.shipping_address = { ...order.shipping_address, address1: "Rua Abel Francisco Caniçais, 583" };
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.address, "Rua Abel Francisco Caniçais");
  assertEquals(cartRequestBody.to.number, "583");
});

Deno.test("falls back to S/N when address1 genuinely has no trailing number", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.shipping_address = { ...order.shipping_address, address1: "Sitio Sao Joao, Zona Rural" };
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.address, "Sitio Sao Joao, Zona Rural");
  assertEquals(cartRequestBody.to.number, "S/N");
});

Deno.test("splits address2 into complement + district at the last comma (bairro has no dedicated Shopify field)", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  (order.shipping_address as Record<string, unknown>).address2 = "casa 10, Vasco da Gama";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.complement, "casa 10");
  assertEquals(cartRequestBody.to.district, "Vasco da Gama");
});

Deno.test("treats address2 as the district alone when it has no comma (no separate complement given)", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  (order.shipping_address as Record<string, unknown>).address2 = "Savoy";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.complement, undefined);
  assertEquals(cartRequestBody.to.district, "Savoy");
});

Deno.test("falls back to the note_attributes neighborhood, then Nao informado, when address2 is empty", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  (order.shipping_address as Record<string, unknown>).neighborhood = "Centro";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.district, "Centro");
});

Deno.test("strips the +55 country code from the recipient phone instead of letting it get misread as the DDD", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  (order.shipping_address as Record<string, unknown>).phone = "+5513996435307";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.phone, "13996435307");
});

Deno.test("leaves a recipient phone with no country code untouched", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  (order.shipping_address as Record<string, unknown>).phone = "21974983395";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.phone, "21974983395");
});

Deno.test("sends the stored customer_email as the recipient email on the cart payload", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  order.customer_email = "cliente@example.com";
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  assertEquals(cartRequestBody.to.email, "cliente@example.com");
});

Deno.test("fails with a clear, reprocessable message instead of crashing when Melhor Envio's checkout returns an empty body", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeApprovedOrder());

  await withFetchMock(
    (url, init) => {
      if (url.includes("/me/shipment/checkout")) {
        return new Response("", { status: 200 }); // 2xx with an empty body -> meFetch resolves undefined
      }
      return meAndShopifyHandler()(url, init);
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, config, "order-happy-1"),
  );

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "failed");
  assertEquals(order.last_error, "Melhor Envio checkout returned an empty response — retry via Reprocessar");
});

Deno.test("carries the real Melhor Envio error message (not just the HTTP status) into last_error", async () => {
  const fake = makeFakeSupabase();
  fake.table("orders_shipping").push(makeApprovedOrder());

  await withFetchMock(
    (url, init) => {
      if (url.includes("/me/cart")) {
        return jsonResponse({ message: "CEP de destino não atendido por essa transportadora" }, 422);
      }
      return meAndShopifyHandler()(url, init);
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, config, "order-happy-1"),
  );

  const order = fake.table("orders_shipping")[0];
  assertEquals(order.status, "failed");
  assertEquals(order.last_error, "Melhor Envio API error 422: CEP de destino não atendido por essa transportadora");
});

Deno.test("resumes past a stalled 'purchased' status when the label was already generated on a prior run", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  // Simulates the exact regression: label + purchase already succeeded on a
  // previous run, but the pipeline stalled at "purchased" instead of moving
  // on to "label_generated" because that step's idempotent skip-path forgot
  // to write the status forward.
  Object.assign(order, {
    status: "failed",
    melhor_envio_cart_id: "me-cart-1",
    melhor_envio_order_id: "me-order-1",
    label_pdf_url: "https://melhorenvio.com.br/labels/me-order-1.pdf",
  });
  fake.table("orders_shipping").push(order);

  await withFetchMock(meAndShopifyHandler(), () =>
    // deno-lint-ignore no-explicit-any
    runShippingPipeline(fake as any, config, "order-happy-1"));

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "tracking_synced");
  assertEquals(updated.shopify_fulfillment_id, "gid://shopify/Fulfillment/1");
});

Deno.test("does not fabricate a tracking code from the internal Melhor Envio order id when the carrier hasn't assigned one yet", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  // Same "stalled and retried" shape as the test above — the pipeline only
  // ever reaches syncTrackingStep mid-run, so a stuck order is persisted as
  // "failed" with the earlier steps' output already filled in.
  Object.assign(order, {
    status: "failed",
    melhor_envio_cart_id: "me-cart-1",
    melhor_envio_order_id: "me-order-1",
    label_pdf_url: "https://melhorenvio.com.br/labels/me-order-1.pdf",
  });
  fake.table("orders_shipping").push(order);

  await withFetchMock(
    (url, init) => {
      if (url.includes("/me/shipment/tracking")) {
        return jsonResponse({ "me-order-1": { id: "me-order-1", status: "generated" } }); // no `tracking` yet
      }
      return meAndShopifyHandler()(url, init);
    },
    // deno-lint-ignore no-explicit-any
    () => runShippingPipeline(fake as any, config, "order-happy-1"),
  );

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "failed");
  assertEquals(updated.shopify_fulfillment_id, undefined);
  if (!/tracking code not yet available/i.test(String(updated.last_error))) {
    throw new Error(`expected last_error to explain the missing tracking code, got: ${updated.last_error}`);
  }
});

Deno.test("fetches the recipient CPF live via localizationExtensions when the stored snapshot has none", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  delete (order.shipping_address as any).document;
  fake.table("orders_shipping").push(order);

  let cartRequestBody: any;
  await withFetchMock((url, init) => {
    if (url.includes("/me/cart")) cartRequestBody = JSON.parse(init.body as string);
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes("/graphql.json") && typeof body?.query === "string" && body.query.includes("GetLocalizationExtensions")) {
      return jsonResponse({
        data: { order: { localizationExtensions: { edges: [{ node: { key: "TAX_CREDENTIAL_BR", value: "159.335.626-96 ", purpose: "TAX", countryCode: "BR" } }] } } },
      });
    }
    return meAndShopifyHandler()(url, init);
    // deno-lint-ignore no-explicit-any
  }, () => runShippingPipeline(fake as any, config, "order-happy-1"));

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "tracking_synced");
  assertEquals(cartRequestBody.to.document, "15933562696");
});

Deno.test("blocks with a descriptive failed status when no recipient CPF/CNPJ is available anywhere", async () => {
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  delete (order.shipping_address as any).document;
  fake.table("orders_shipping").push(order);

  await withFetchMock(meAndShopifyHandler(), () =>
    // deno-lint-ignore no-explicit-any
    runShippingPipeline(fake as any, config, "order-happy-1"));

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "failed");
  if (!/document|cpf/i.test(String(updated.last_error))) {
    throw new Error(`expected last_error to mention document/cpf, got: ${updated.last_error}`);
  }
});

Deno.test("cancelOrderLabel moves an order to held even when it failed before ever purchasing a label", async () => {
  // Previously a dead click: an order that failed at cart creation (e.g. an
  // invalid CEP) has no melhor_envio_order_id, so there was nothing to
  // cancel at Melhor Envio and the function just returned without touching
  // status — leaving it stuck in "failed" forever with no way back into the
  // queue, even after someone fixed the underlying Shopify address.
  const fake = makeFakeSupabase();
  const order = makeApprovedOrder();
  Object.assign(order, { status: "failed", last_error: "Melhor Envio API error 422: CEP invalido" });
  fake.table("orders_shipping").push(order);

  // No fetch mock at all — asserts this path never calls Melhor Envio, since
  // there's genuinely nothing to cancel.
  // deno-lint-ignore no-explicit-any
  await cancelOrderLabel(fake as any, config, "order-happy-1", "endereco corrigido, reenviar");

  const updated = fake.table("orders_shipping")[0];
  assertEquals(updated.status, "held");
  assertEquals(updated.held_reason, "endereco corrigido, reenviar");
});
