import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import type { OrderCandidate } from "./shopify.ts";

export type ShippingStatus =
  | "pending_approval"
  | "approved"
  | "cart_created"
  | "purchased"
  | "label_generated"
  | "tracking_ready"
  | "tracking_synced"
  | "held"
  | "failed"
  | "archived"
  | "external";

export interface OrderShippingRow {
  id: string;
  store_key: string;
  shopify_order_id: string;
  shopify_order_number: string | null;
  shopify_graphql_id: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  currency: string;
  total_price: string;
  paid_at: string | null;
  items: unknown;
  shipping_address: Record<string, unknown>;
  status: ShippingStatus;
  last_error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  held_reason: string | null;
  held_by: string | null;
  held_at: string | null;
  melhor_envio_cart_id: string | null;
  melhor_envio_order_id: string | null;
  melhor_envio_label_id: string | null;
  melhor_envio_protocol: string | null;
  shipping_price: number | null;
  tracking_code: string | null;
  tracking_company: string | null;
  label_pdf_url: string | null;
  shopify_fulfillment_id: string | null;
  webhook_event_id: string | null;
  posted_at: string | null;
  posted_by: string | null;
  created_at: string;
  updated_at: string;
}

export function createServiceClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

// The panel JS (supabase/functions/panel/public/app.js) is carried over
// unchanged from the old Prisma-backed API, which returned camelCase field
// names (Prisma model fields, @map'd to snake_case columns). The Postgres
// rows here are plain snake_case, so every row returned to the panel goes
// through this to keep the panel's existing rendering code working as-is.
export interface OrderShippingApiShape {
  id: string;
  storeKey: string;
  shopifyOrderId: string;
  shopifyOrderNumber: string | null;
  shopifyGraphqlId: string | null;
  financialStatus: string;
  fulfillmentStatus: string | null;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  totalPrice: string;
  paidAt: string | null;
  items: unknown;
  shippingAddress: Record<string, unknown>;
  status: ShippingStatus;
  lastError: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  heldReason: string | null;
  heldBy: string | null;
  heldAt: string | null;
  melhorEnvioCartId: string | null;
  melhorEnvioOrderId: string | null;
  melhorEnvioLabelId: string | null;
  melhorEnvioProtocol: string | null;
  shippingPrice: number | null;
  trackingCode: string | null;
  trackingCompany: string | null;
  labelPdfUrl: string | null;
  shopifyFulfillmentId: string | null;
  webhookEventId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toApiShape(row: OrderShippingRow): OrderShippingApiShape {
  return {
    id: row.id,
    storeKey: row.store_key,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderNumber: row.shopify_order_number,
    shopifyGraphqlId: row.shopify_graphql_id,
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    currency: row.currency,
    totalPrice: row.total_price,
    paidAt: row.paid_at,
    items: row.items,
    shippingAddress: row.shipping_address,
    status: row.status,
    lastError: row.last_error,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    heldReason: row.held_reason,
    heldBy: row.held_by,
    heldAt: row.held_at,
    melhorEnvioCartId: row.melhor_envio_cart_id,
    melhorEnvioOrderId: row.melhor_envio_order_id,
    melhorEnvioLabelId: row.melhor_envio_label_id,
    melhorEnvioProtocol: row.melhor_envio_protocol,
    shippingPrice: row.shipping_price,
    trackingCode: row.tracking_code,
    trackingCompany: row.tracking_company,
    labelPdfUrl: row.label_pdf_url,
    shopifyFulfillmentId: row.shopify_fulfillment_id,
    webhookEventId: row.webhook_event_id,
    postedAt: row.posted_at,
    postedBy: row.posted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

// Both the webhook and the reconciliation cron call this. It only ever
// creates/updates a row as pending_approval — it never enqueues the shipping
// pipeline. That happens exclusively through the manual approval endpoint.
//
// A plain upsert can't express "skip if held or already in pipeline", so this
// does a read-then-conditional-write instead, mirroring the original Prisma
// semantics exactly.
export async function upsertPendingCandidate(
  supabase: SupabaseClient,
  candidate: OrderCandidate,
  storeKey: string,
  webhookEventId?: string,
): Promise<OrderShippingRow> {
  const { data: existing, error: selectError } = await supabase
    .from("orders_shipping")
    .select("*")
    .eq("store_key", storeKey)
    .eq("shopify_order_id", candidate.shopifyOrderId)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing && existing.status === "held") {
    log(
      { storeKey, shopifyOrderId: candidate.shopifyOrderId },
      "candidate_skipped_held_order_stays_out_of_queue",
    );
    return existing as OrderShippingRow;
  }

  if (existing && existing.status !== "pending_approval") {
    log(
      { storeKey, shopifyOrderId: candidate.shopifyOrderId, status: existing.status },
      "candidate_skipped_already_in_pipeline",
    );
    return existing as OrderShippingRow;
  }

  const mutableFields = {
    financial_status: candidate.financialStatus,
    fulfillment_status: candidate.fulfillmentStatus,
    customer_name: candidate.customerName,
    customer_email: candidate.customerEmail,
    total_price: candidate.totalPrice,
    paid_at: candidate.paidAt ? candidate.paidAt.toISOString() : null,
    items: candidate.items,
    shipping_address: candidate.shippingAddress ?? {},
  };

  if (existing) {
    const { data, error } = await supabase
      .from("orders_shipping")
      .update({
        ...mutableFields,
        webhook_event_id: webhookEventId ?? existing.webhook_event_id,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    log({ storeKey, shopifyOrderId: candidate.shopifyOrderId, created: false }, "candidate_upserted_pending_approval");
    return data as OrderShippingRow;
  }

  const { data, error } = await supabase
    .from("orders_shipping")
    .insert({
      store_key: storeKey,
      shopify_order_id: candidate.shopifyOrderId,
      shopify_order_number: candidate.shopifyOrderNumber,
      shopify_graphql_id: candidate.shopifyGraphqlId,
      ...mutableFields,
      status: "pending_approval",
      webhook_event_id: webhookEventId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;

  log({ storeKey, shopifyOrderId: candidate.shopifyOrderId, created: true }, "candidate_upserted_pending_approval");
  return data as OrderShippingRow;
}

// Records an order fulfilled entirely outside this system (see the webhook's
// "already_fulfilled" check) so it isn't just silently dropped -- purely for
// visibility/history, never a queue anything gets approved out of. Same
// read-then-conditional-write shape as upsertPendingCandidate, but the only
// safe transitions into "external" are from nowhere (brand new row) or from
// "pending_approval" (we hadn't started on it yet) -- anything already
// further along in our own pipeline, held, or archived is left untouched.
export async function upsertExternalCandidate(
  supabase: SupabaseClient,
  candidate: OrderCandidate,
  storeKey: string,
  trackingCode: string | null,
  trackingCompany: string | null,
): Promise<OrderShippingRow> {
  const { data: existing, error: selectError } = await supabase
    .from("orders_shipping")
    .select("*")
    .eq("store_key", storeKey)
    .eq("shopify_order_id", candidate.shopifyOrderId)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing && existing.status !== "pending_approval" && existing.status !== "external") {
    log(
      { storeKey, shopifyOrderId: candidate.shopifyOrderId, status: existing.status },
      "external_candidate_skipped_not_ours_to_touch",
    );
    return existing as OrderShippingRow;
  }

  const mutableFields = {
    financial_status: candidate.financialStatus,
    fulfillment_status: candidate.fulfillmentStatus,
    customer_name: candidate.customerName,
    customer_email: candidate.customerEmail,
    total_price: candidate.totalPrice,
    paid_at: candidate.paidAt ? candidate.paidAt.toISOString() : null,
    items: candidate.items,
    shipping_address: candidate.shippingAddress ?? {},
    tracking_code: trackingCode,
    tracking_company: trackingCompany,
    status: "external" as const,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("orders_shipping")
      .update(mutableFields)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    log({ storeKey, shopifyOrderId: candidate.shopifyOrderId, created: false }, "candidate_upserted_external");
    return data as OrderShippingRow;
  }

  const { data, error } = await supabase
    .from("orders_shipping")
    .insert({
      store_key: storeKey,
      shopify_order_id: candidate.shopifyOrderId,
      shopify_order_number: candidate.shopifyOrderNumber,
      shopify_graphql_id: candidate.shopifyGraphqlId,
      ...mutableFields,
    })
    .select("*")
    .single();
  if (error) throw error;

  log({ storeKey, shopifyOrderId: candidate.shopifyOrderId, created: true }, "candidate_upserted_external");
  return data as OrderShippingRow;
}
