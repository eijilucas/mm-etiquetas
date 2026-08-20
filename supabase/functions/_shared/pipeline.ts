import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import type { OrderItemSnapshot } from "./shopify.ts";
import { createFulfillment, fetchRecipientTaxCredential } from "./shopify.ts";
import { getStoreByKey } from "./config.ts";
import type { OrderShippingRow } from "./db.ts";
import {
  addToCart,
  buildFromAddress,
  checkoutCart,
  fetchTrackingByOrderId,
  generateLabel,
  InsufficientBalanceError,
  MelhorEnvioApiError,
  pickCheapestServiceId,
  printLabel,
  cancelLabel,
} from "./melhorenvio.ts";
import type { MeCartRequest } from "./melhorenvio.ts";
import { reportLabelGenerated, reportLabelCancelled } from "./estoque.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

export async function sendAlert(config: AppConfig, text: string): Promise<void> {
  if (!config.alerts.webhookUrl) {
    log({ text, level: "warn" }, "alert_webhook_not_configured");
    return;
  }
  try {
    await fetch(config.alerts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    log({ err: String(error), level: "error" }, "alert_webhook_send_failed");
  }
}

export class MissingRecipientDocumentError extends Error {
  constructor(shopifyOrderId: string) {
    super(
      `Order ${shopifyOrderId} has no recipient CPF/CNPJ (customer_document note attribute) — Melhor Envio requires it for the destination address`,
    );
    this.name = "MissingRecipientDocumentError";
  }
}

// Shopify's REST address model has no dedicated house-number field — this
// store's checkout (Appmax) bakes it into address1 as "Rua X, 583" instead,
// so the label previously always showed "S/N" (no number) even when the
// number was right there in the text. Only addresses with no trailing
// number (rare, but real) fall back to "S/N".
const ADDRESS_NUMBER_RE = /^(.*?),?\s*(\d+[a-zA-Z]?)\s*$/;

function splitAddressAndNumber(address1: string): { address: string; number: string } {
  const match = address1.match(ADDRESS_NUMBER_RE);
  if (!match || !match[1]) return { address: address1, number: "S/N" };
  return { address: match[1].trim(), number: match[2] };
}

// Same root cause as the house number: no dedicated bairro field, so this
// checkout bakes it into address2 as "[complemento, ]bairro" — verified
// against 29 real orders from both stores, the neighborhood is consistently
// the last comma-separated segment (e.g. "casa 10, Vasco da Gama" or just
// "Savoy" when there's no separate complement). This is checked BEFORE the
// note_attributes-sourced neighborhood (see mapShopifyOrderToCandidate in
// shopify.ts) because that field was observed holding a stale
// "Bairro Não Informado" placeholder on orders where address2 already had
// the real neighborhood.
function splitComplementAndDistrict(address2: string | null | undefined): { complement?: string; district?: string } {
  const raw = (address2 ?? "").trim();
  if (!raw) return {};
  const lastComma = raw.lastIndexOf(",");
  if (lastComma === -1) return { district: raw };
  return {
    complement: raw.slice(0, lastComma).trim() || undefined,
    district: raw.slice(lastComma + 1).trim() || undefined,
  };
}

// Shopify phones come in inconsistently — some with a "+55" country-code
// prefix, most without. Melhor Envio's own sender phone (MELHORENVIO_FROM_PHONE)
// is plain DDD+number with no prefix, and expects the same shape for the
// recipient: with the prefix left on, it reads the leading "55" as the DDD
// and truncates the real number (confirmed on a live label: "+5513996435307"
// printed as "(55) 13996-4353" instead of "(13) 99643-5307").
function normalizeBrazilianPhone(phone: string | null | undefined): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length > 11 && digits.startsWith("55")) return digits.slice(2);
  return digits || undefined;
}

function toAddress(raw: Record<string, unknown>, shopifyOrderId: string, customerEmail: string | null) {
  const address = raw as {
    name?: string;
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string | null;
    city?: string;
    province_code?: string | null;
    zip?: string;
    country_code?: string;
    phone?: string | null;
    // Not native Shopify fields — see mapShopifyOrderToCandidate in shopify.ts.
    document?: string;
    neighborhood?: string;
  };
  if (!address.document) {
    throw new MissingRecipientDocumentError(shopifyOrderId);
  }
  const name = address.name ?? [address.first_name, address.last_name].filter(Boolean).join(" ");
  const { address: streetAddress, number } = splitAddressAndNumber(address.address1 ?? "");
  const { complement, district } = splitComplementAndDistrict(address.address2);
  return {
    name: name || "Cliente",
    phone: normalizeBrazilianPhone(address.phone),
    email: customerEmail ?? undefined,
    document: address.document,
    postal_code: (address.zip ?? "").replace(/\D/g, ""),
    address: streetAddress,
    number,
    complement,
    // Unlike the recipient document, Melhor Envio doesn't hard-require a
    // district — it's not always recoverable from Shopify's data, so this
    // falls back instead of blocking the pipeline.
    district: district ?? address.neighborhood ?? "Nao informado",
    city: address.city ?? "",
    state_abbr: address.province_code ?? "",
  };
}

export async function buildCartPayload(config: AppConfig, order: OrderShippingRow): Promise<MeCartRequest> {
  const items = order.items as unknown as OrderItemSnapshot[];
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  // Fixed estimate by item count, matching Vitor's manual process exactly —
  // the store doesn't track real per-product weight/dimensions in Shopify.
  const profile = totalQuantity <= 1 ? config.melhorEnvio.volumeProfile.single : config.melhorEnvio.volumeProfile.multiple;

  // Declared value follows the same fixed-convention logic as the volume
  // profile above — R$250/produto regardless of the real Shopify sale price,
  // which is what actually drives the auto-generated content declaration
  // (products[].unitary_value, see the `options` comment below). Insurance
  // value is kept consistent with that same declared total.
  const declaredValuePerItem = config.melhorEnvio.declaredValuePerItem;
  const insuranceValue = declaredValuePerItem * totalQuantity;

  const shippingAddress = { ...(order.shipping_address as Record<string, unknown>) };
  if (!shippingAddress.document) {
    // Neither the webhook payload nor the reconciliation REST fetch carries
    // the recipient CPF/CNPJ (it's GraphQL-only — see fetchRecipientTaxCredential),
    // and not every store's checkout captures it via note_attributes either,
    // so it's fetched live here, right before it's actually needed.
    const store = getStoreByKey(config, order.store_key);
    if (store) {
      const graphqlId = order.shopify_graphql_id ?? `gid://shopify/Order/${order.shopify_order_id}`;
      shippingAddress.document = await fetchRecipientTaxCredential(store, graphqlId);
    }
  }

  const base: Omit<MeCartRequest, "service"> = {
    from: buildFromAddress(config),
    to: toAddress(shippingAddress, order.shopify_order_id, order.customer_email),
    products: items.map((item) => ({
      name: item.title,
      quantity: item.quantity,
      unitary_value: declaredValuePerItem,
    })),
    volumes: [
      {
        height: profile.heightCm,
        width: profile.widthCm,
        length: profile.lengthCm,
        weight: profile.weightKg,
      },
    ],
    options: {
      insurance_value: insuranceValue,
      // Declaracao de conteudo automatica do Melhor Envio a partir de
      // products[].unitary_value substitui a NF-e para fins da etiqueta;
      // por isso nunca enviamos `invoice` aqui.
      non_commercial: true,
      platform: config.melhorEnvio.platformName,
    },
  };

  const service = await pickCheapestServiceId(config, base, order.shopify_order_id);
  return { service, ...base };
}

async function fetchOrder(supabase: SupabaseClient, id: string): Promise<OrderShippingRow> {
  const { data, error } = await supabase.from("orders_shipping").select("*").eq("id", id).single();
  if (error) throw error;
  return data as OrderShippingRow;
}

async function updateOrder(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<OrderShippingRow> {
  const { data, error } = await supabase.from("orders_shipping").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  return data as OrderShippingRow;
}

// Each branch below only runs the steps still missing for the current
// status, so re-running the pipeline on a partially completed order never
// repeats an already-successful external call (idempotent by DB status).
export async function runShippingPipeline(
  supabase: SupabaseClient,
  config: AppConfig,
  orderShippingId: string,
): Promise<void> {
  let order = await fetchOrder(supabase, orderShippingId);

  if (
    order.status !== "approved" &&
    order.status !== "cart_created" &&
    order.status !== "purchased" &&
    order.status !== "failed"
  ) {
    log({ orderShippingId, status: order.status }, "pipeline_skip_non_actionable_status");
    return;
  }

  try {
    if (order.status === "approved" || order.status === "failed") {
      order = await createCartStep(supabase, config, order);
    }
    if (order.status === "cart_created") {
      order = await purchaseStep(supabase, config, order);
    }
    if (order.status === "purchased") {
      order = await generateAndPrintLabelStep(supabase, config, order);
    }
    if (order.status === "label_generated") {
      order = await syncTrackingStep(supabase, config, order);
    }
  } catch (error) {
    await handlePipelineFailure(supabase, config, order, error);
  }
}

async function createCartStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (order.melhor_envio_cart_id) {
    return updateOrder(supabase, order.id, { status: "cart_created" });
  }
  const payload = await buildCartPayload(config, order);
  const cartItem = await addToCart(config, payload);
  log({ orderShippingId: order.id, cartId: cartItem.id }, "pipeline_cart_created");
  return updateOrder(supabase, order.id, {
    melhor_envio_cart_id: cartItem.id,
    status: "cart_created",
    last_error: null,
  });
}

async function purchaseStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (order.melhor_envio_order_id) {
    return updateOrder(supabase, order.id, { status: "purchased" });
  }
  if (!order.melhor_envio_cart_id) {
    throw new Error("Cannot purchase: missing melhorEnvioCartId");
  }
  const checkout = await checkoutCart(config, [order.melhor_envio_cart_id]);
  const purchasedOrderId = checkout.purchase?.orders?.[0]?.id ?? order.melhor_envio_cart_id;
  log({ orderShippingId: order.id, meOrderId: purchasedOrderId }, "pipeline_purchased");
  return updateOrder(supabase, order.id, {
    melhor_envio_order_id: purchasedOrderId,
    melhor_envio_protocol: checkout.purchase?.protocol ?? null,
    status: "purchased",
    last_error: null,
  });
}

async function generateAndPrintLabelStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (!order.melhor_envio_order_id) {
    throw new Error("Cannot generate label: missing melhorEnvioOrderId");
  }
  if (!order.label_pdf_url) {
    await generateLabel(config, [order.melhor_envio_order_id]);
    const printed = await printLabel(config, [order.melhor_envio_order_id]);
    log({ orderShippingId: order.id, url: printed.url }, "pipeline_label_generated");
    // Best-effort, never blocks the pipeline — see estoque.ts.
    await reportLabelGenerated(config, order.shopify_order_id, order.items);
    return updateOrder(supabase, order.id, {
      melhor_envio_label_id: order.melhor_envio_order_id,
      label_pdf_url: printed.url,
      status: "label_generated",
      last_error: null,
    });
  }
  // Label was already generated on a prior run (e.g. this step succeeded but
  // a later one failed) — still need to move status forward so the pipeline
  // doesn't silently stall at "purchased" on retry.
  if (order.status !== "label_generated") {
    return updateOrder(supabase, order.id, { status: "label_generated" });
  }
  return order;
}

async function syncTrackingStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (order.tracking_code && order.shopify_fulfillment_id) {
    return updateOrder(supabase, order.id, { status: "tracking_synced" });
  }
  if (!order.melhor_envio_order_id) {
    throw new Error("Cannot sync tracking: missing melhorEnvioOrderId");
  }
  // /me/shipment/generate never returns a tracking code, and the carrier
  // typically only assigns one once the shipment is actually posted — so
  // this polls /me/shipment/tracking and throws (leaving the order retryable
  // via reprocess) instead of ever faking a code from the internal order id.
  const trackingCode = order.tracking_code ?? (await fetchTrackingByOrderId(config, order.melhor_envio_order_id));
  if (!trackingCode) {
    throw new Error("Tracking code not yet available from Melhor Envio for this order");
  }

  const store = getStoreByKey(config, order.store_key);
  if (!store) {
    throw new Error(`No Shopify store configured for storeKey "${order.store_key}"`);
  }

  const fulfillment = await createFulfillment(store, {
    shopifyOrderGraphqlId: order.shopify_graphql_id ?? `gid://shopify/Order/${order.shopify_order_id}`,
    trackingInfo: {
      number: trackingCode,
      // Melhor Envio isn't in Shopify's known-carrier list, so it always
      // shows as "Outra" (Other) in the admin regardless of this string —
      // what actually needs to be right is the tracking URL: the customer's
      // link must go to a tracking lookup page, not the raw label PDF.
      company: "Melhor Envio",
      url: config.melhorEnvio.trackingUrl,
    },
    notifyCustomer: true,
  });

  log({ orderShippingId: order.id, fulfillmentId: fulfillment.fulfillmentId }, "pipeline_tracking_synced");
  return updateOrder(supabase, order.id, {
    tracking_code: trackingCode,
    shopify_fulfillment_id: fulfillment.fulfillmentId,
    status: "tracking_synced",
    last_error: null,
  });
}

async function handlePipelineFailure(
  supabase: SupabaseClient,
  config: AppConfig,
  order: OrderShippingRow,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  log({ orderShippingId: order.id, err: message, level: "error" }, "pipeline_step_failed");

  await updateOrder(supabase, order.id, { status: "failed", last_error: message });

  if (error instanceof InsufficientBalanceError) {
    await sendAlert(
      config,
      `[mm-etiquetas] Pedido ${order.shopify_order_number ?? order.shopify_order_id}: saldo insuficiente na Melhor Envio.`,
    );
    return;
  }
  if (error instanceof MelhorEnvioApiError) {
    await sendAlert(
      config,
      `[mm-etiquetas] Pedido ${order.shopify_order_number ?? order.shopify_order_id}: falha na Melhor Envio (${message}).`,
    );
    return;
  }
  await sendAlert(
    config,
    `[mm-etiquetas] Pedido ${order.shopify_order_number ?? order.shopify_order_id}: falha no pipeline (${message}).`,
  );
}

export async function cancelOrderLabel(
  supabase: SupabaseClient,
  config: AppConfig,
  orderShippingId: string,
  reason: string,
): Promise<void> {
  const order = await fetchOrder(supabase, orderShippingId);
  if (!order.melhor_envio_order_id) {
    log({ orderShippingId }, "cancel_skipped_no_label_purchased");
    return;
  }
  await cancelLabel(config, [order.melhor_envio_order_id], reason);
  // Best-effort — no-ops on the estoque side if stock was never deducted
  // for this order (e.g. cancelled before generateAndPrintLabelStep ran).
  await reportLabelCancelled(config, order.shopify_order_id, order.items);
  await updateOrder(supabase, order.id, { status: "held", held_reason: reason, held_at: new Date().toISOString() });
}
