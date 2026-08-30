import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import type { OrderItemSnapshot } from "./shopify.ts";
import { createFulfillment, fetchRecipientTaxCredential } from "./shopify.ts";
import { getStoreByKey } from "./config.ts";
import type { OrderShippingRow } from "./db.ts";
import {
  addToCart,
  buildFromAddress,
  calculateShipping,
  checkoutCart,
  fetchAccountBalance,
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

// Shared with reconciliation.ts's retryStalledTracking, which auto-retries
// exactly this failure (and only this one — every other failure reason
// needs a human, retrying wouldn't fix an invalid CEP for example).
export const TRACKING_NOT_YET_AVAILABLE_ERROR = "Tracking code not yet available from Melhor Envio for this order";

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

// Same volume/insurance/address inputs as buildCartPayload, but a plain
// price quote (/me/shipment/calculate) instead of actually building a cart
// — used to preview the cost of a batch of orders before approving any of
// them, so it deliberately skips the live recipient-CPF fetch (calculate
// doesn't need it, and a pending_approval batch can be dozens of orders —
// no need to pay that extra Shopify round-trip per order just for an
// estimate). Best-effort: any failure (bad CEP, Melhor Envio down, no valid
// quote) returns null rather than throwing, so one bad order can't block
// previewing the rest of the batch.
export async function estimateShippingCost(config: AppConfig, order: OrderShippingRow): Promise<number | null> {
  try {
    const items = order.items as unknown as OrderItemSnapshot[];
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    if (totalQuantity <= 0) return null;
    const profile = totalQuantity <= 1 ? config.melhorEnvio.volumeProfile.single : config.melhorEnvio.volumeProfile.multiple;
    const declaredValuePerItem = config.melhorEnvio.declaredValuePerItem;

    const shippingAddress = order.shipping_address as Record<string, unknown>;
    const postalCode = String(shippingAddress.zip ?? "").replace(/\D/g, "");
    if (!postalCode) return null;

    const quotes = await calculateShipping(config, {
      from: buildFromAddress(config),
      to: {
        postal_code: postalCode,
        address: String(shippingAddress.address1 ?? ""),
        number: "0",
        district: "N/A",
        city: String(shippingAddress.city ?? ""),
        state_abbr: String(shippingAddress.province_code ?? ""),
      },
      products: items.map((item) => ({ name: item.title, quantity: item.quantity, unitary_value: declaredValuePerItem })),
      volumes: [{ height: profile.heightCm, width: profile.widthCm, length: profile.lengthCm, weight: profile.weightKg }],
      options: { insurance_value: declaredValuePerItem * totalQuantity },
    });

    const allowed = config.melhorEnvio.allowedServiceIds;
    const valid = quotes.filter((quote) => {
      if (quote.error) return false;
      const price = Number(quote.price);
      if (!Number.isFinite(price) || price <= 0) return false;
      if (allowed.length > 0 && !allowed.includes(quote.id)) return false;
      return true;
    });
    if (valid.length === 0) return null;

    const cheapest = valid.reduce((min, quote) => (Number(quote.price) < Number(min.price) ? quote : min));
    return Number(cheapest.price);
  } catch (error) {
    log({ orderShippingId: order.id, err: String(error), level: "warn" }, "estimate_shipping_cost_failed");
    return null;
  }
}

// Melhor Envio rejects to.address over this length with a 422 (confirmed
// live: "Endereco de destino - 64 caracteres") — checked against the same
// street-only string toAddress actually sends (post splitAddressAndNumber),
// not the raw address1, since a trailing house number gets split off first.
const MELHOR_ENVIO_ADDRESS_MAX_LENGTH = 64;

// Surfaces the failure classes that are actually predictable ahead of
// approval (unlike a checkout-time 500 or Melhor Envio going down, which
// can't be front-run): a missing recipient CPF/CNPJ and an address over
// Melhor Envio's length limit — buildCartPayload's toAddress always throws
// on either, no fallback exists — and no valid shipping quote, which is a
// softer signal since createCartStep still falls back to the fixed default
// service either way, so it doesn't guarantee a failure the way those do.
export async function checkApprovalIssues(
  config: AppConfig,
  order: OrderShippingRow,
): Promise<{ price: number | null; blocking: string[]; warnings: string[] }> {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const price = await estimateShippingCost(config, order);
  if (price == null) warnings.push("Sem cotacao de frete confirmada para o CEP/endereco (pode cair no frete padrao ou falhar)");

  const shippingAddress = order.shipping_address as Record<string, unknown>;

  const { address: streetAddress } = splitAddressAndNumber(String(shippingAddress.address1 ?? ""));
  if (streetAddress.length > MELHOR_ENVIO_ADDRESS_MAX_LENGTH) {
    blocking.push(
      `Endereco com ${streetAddress.length} caracteres (limite da Melhor Envio e ${MELHOR_ENVIO_ADDRESS_MAX_LENGTH}) — a compra do frete vai falhar, precisa encurtar o endereco antes`,
    );
  }

  if (!shippingAddress.document) {
    let hasDocument = false;
    const store = getStoreByKey(config, order.store_key);
    if (store) {
      const graphqlId = order.shopify_graphql_id ?? `gid://shopify/Order/${order.shopify_order_id}`;
      try {
        hasDocument = !!(await fetchRecipientTaxCredential(store, graphqlId));
      } catch (error) {
        log({ orderShippingId: order.id, err: String(error), level: "warn" }, "check_approval_document_lookup_failed");
      }
    }
    if (!hasDocument) blocking.push("CPF/CNPJ do destinatario ausente — a compra do frete vai falhar");
  }

  return { price, blocking, warnings };
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

// Long enough that no single pipeline run should legitimately still hold
// the claim (an Edge Function has a hard execution ceiling well under
// this), short enough that a run that crashed without releasing its claim
// (e.g. the function got killed rather than throwing) doesn't strand the
// order forever.
const PROCESSING_LOCK_STALE_MINUTES = 5;

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

  // Claims the order for this run before doing any real work, so two
  // overlapping invocations (a manual reconciliation trigger landing
  // seconds from the scheduled cron, a double-clicked Reprocessar) can't
  // both pass the same "already have a cart / already purchased"
  // idempotency check before either writes back — without this, that race
  // could buy the same shipment twice, or let a losing run's failure
  // overwrite a winning run's success.
  const staleBefore = new Date(Date.now() - PROCESSING_LOCK_STALE_MINUTES * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("orders_shipping")
    .update({ processing_started_at: new Date().toISOString() })
    .eq("id", orderShippingId)
    .or(`processing_started_at.is.null,processing_started_at.lt.${staleBefore}`)
    .select("*");
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    log({ orderShippingId }, "pipeline_skip_already_processing");
    return;
  }
  order = claimed[0] as OrderShippingRow;

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
  } finally {
    await updateOrder(supabase, orderShippingId, { processing_started_at: null }).catch((err) =>
      log({ orderShippingId, err: String(err), level: "error" }, "pipeline_lock_release_failed"),
    );
  }
}

async function createCartStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (order.melhor_envio_cart_id) {
    return updateOrder(supabase, order.id, { status: "cart_created" });
  }
  const payload = await buildCartPayload(config, order);
  const cartItem = await addToCart(config, payload);
  const shippingPrice = Number(cartItem.price);
  log({ orderShippingId: order.id, cartId: cartItem.id, price: cartItem.price }, "pipeline_cart_created");
  return updateOrder(supabase, order.id, {
    melhor_envio_cart_id: cartItem.id,
    // POST /me/cart already quotes the price for the chosen service — no
    // extra call needed, just persisting what was previously only logged.
    shipping_price: Number.isFinite(shippingPrice) ? shippingPrice : null,
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
  // meFetch returns undefined for a 2xx response with an empty body — rare,
  // but was hitting an unguarded checkout.purchase and throwing a useless
  // "Cannot read properties of undefined" instead of something reprocessable.
  if (!checkout) {
    throw new Error("Melhor Envio checkout returned an empty response — retry via Reprocessar");
  }
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

// Only fetches and stores the code — does NOT notify Shopify/the customer.
// That used to happen in the same step, automatically, every time the
// 15min cron retried a stalled order; now it's a deliberate separate action
// (see manualTrackingSync) so a human decides when the customer gets told.
async function syncTrackingStep(supabase: SupabaseClient, config: AppConfig, order: OrderShippingRow): Promise<OrderShippingRow> {
  if (order.tracking_code) {
    return updateOrder(supabase, order.id, { status: "tracking_ready" });
  }
  if (!order.melhor_envio_order_id) {
    throw new Error("Cannot sync tracking: missing melhorEnvioOrderId");
  }
  // /me/shipment/generate never returns a tracking code, and the carrier
  // typically only assigns one once the shipment is actually posted — so
  // this polls /me/shipment/tracking and throws (leaving the order retryable
  // via reprocess) instead of ever faking a code from the internal order id.
  const trackingCode = await fetchTrackingByOrderId(config, order.melhor_envio_order_id);
  if (!trackingCode) {
    throw new Error(TRACKING_NOT_YET_AVAILABLE_ERROR);
  }

  log({ orderShippingId: order.id, trackingCode }, "pipeline_tracking_code_ready");
  return updateOrder(supabase, order.id, {
    tracking_code: trackingCode,
    status: "tracking_ready",
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

  // Two overlapping runs of the same order (e.g. a manual reconciliation
  // trigger landing seconds apart from the scheduled cron) can race here:
  // whichever run finishes last simply overwrites the DB row, so a failure
  // from the losing run could clobber a genuine success from the winning
  // one — Shopify already has the fulfillment, but the order would show
  // "failed" anyway. The status guard makes this write a no-op once the
  // order has already reached the terminal success state.
  const { data: notClobbered } = await supabase
    .from("orders_shipping")
    .update({ status: "failed", last_error: message })
    .eq("id", order.id)
    .neq("status", "tracking_synced")
    .select("id");
  if (!notClobbered || notClobbered.length === 0) {
    log({ orderShippingId: order.id }, "pipeline_failure_write_skipped_already_tracking_synced");
    return;
  }

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

// The only path by which a tracking code ever reaches Shopify (and
// notifies the customer) — deliberately not automatic. Covers two cases:
// (1) the normal flow, where syncTrackingStep already fetched and stored
// the code (status "tracking_ready") and a human clicks Enviar in the
// Rastreio manual tab to release it; (2) orders shipped entirely by hand
// outside this system (e.g. #3290, where the CEP our pipeline rejected
// made Vitor just buy the label directly on Melhor Envio's site), which
// have no melhor_envio_order_id to poll at all. Works from any
// non-terminal status for exactly that reason — these orders can be
// sitting in pending_approval, held, tracking_ready, or failed depending
// on where they are in (or fell out of) the normal flow.
export async function manualTrackingSync(
  supabase: SupabaseClient,
  config: AppConfig,
  orderShippingId: string,
  trackingCode: string,
): Promise<void> {
  const order = await fetchOrder(supabase, orderShippingId);
  if (order.status === "tracking_synced") {
    throw new Error("Pedido ja esta com rastreio sincronizado");
  }
  const store = getStoreByKey(config, order.store_key);
  if (!store) {
    throw new Error(`No Shopify store configured for storeKey "${order.store_key}"`);
  }

  const fulfillment = await createFulfillment(store, {
    shopifyOrderGraphqlId: order.shopify_graphql_id ?? `gid://shopify/Order/${order.shopify_order_id}`,
    trackingInfo: {
      number: trackingCode,
      company: "Melhor Envio",
      url: config.melhorEnvio.trackingUrl,
    },
    notifyCustomer: true,
  });

  log({ orderShippingId: order.id, fulfillmentId: fulfillment.fulfillmentId }, "pipeline_manual_tracking_synced");
  await updateOrder(supabase, order.id, {
    tracking_code: trackingCode,
    shopify_fulfillment_id: fulfillment.fulfillmentId,
    status: "tracking_synced",
    last_error: null,
  });
}

export async function cancelOrderLabel(
  supabase: SupabaseClient,
  config: AppConfig,
  orderShippingId: string,
  reason: string,
): Promise<void> {
  const order = await fetchOrder(supabase, orderShippingId);
  if (!order.melhor_envio_order_id) {
    // Nothing was ever purchased at Melhor Envio (e.g. it failed at cart
    // creation on a bad address) — there's no shipment to cancel, but the
    // order still needs a way out of "failed" and into held/pending_approval,
    // otherwise Cancelar is a dead click and the order is stuck forever even
    // after someone fixes the underlying Shopify data.
    log({ orderShippingId }, "cancel_skipped_no_label_purchased");
    await updateOrder(supabase, order.id, { status: "held", held_reason: reason, held_at: new Date().toISOString() });
    return;
  }
  await cancelLabel(config, [order.melhor_envio_order_id], reason);
  // Best-effort — no-ops on the estoque side if stock was never deducted
  // for this order (e.g. cancelled before generateAndPrintLabelStep ran).
  await reportLabelCancelled(config, order.shopify_order_id, order.items);
  await updateOrder(supabase, order.id, { status: "held", held_reason: reason, held_at: new Date().toISOString() });
}
