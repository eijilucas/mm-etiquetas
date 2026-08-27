import type { StoreConfig } from "./config.ts";
import { withRetry } from "./retry.ts";

export interface ShopifyMoney {
  amount: string;
  currency_code?: string;
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  // Variant-level descriptor (e.g. "P / Preto") — Shopify's own size/color
  // spec, separate from the base product title.
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  price: string;
  grams: number;
}

export interface ShopifyAddress {
  first_name?: string;
  last_name?: string;
  name?: string;
  address1?: string;
  address2?: string | null;
  city?: string;
  province_code?: string | null;
  zip?: string;
  country_code?: string;
  phone?: string | null;
}

export interface ShopifyCustomer {
  id?: number;
  first_name?: string;
  last_name?: string;
  email?: string;
}

// Subset of fields actually consumed from the orders/paid webhook payload
// and from GET /admin/api/orders.json. Shopify sends many more fields.
export interface ShopifyOrder {
  id: number;
  order_number: number;
  admin_graphql_api_id?: string;
  financial_status: string;
  fulfillment_status: string | null;
  currency: string;
  total_price: string;
  processed_at?: string | null;
  created_at?: string;
  customer?: ShopifyCustomer | null;
  email?: string | null;
  shipping_address?: ShopifyAddress | null;
  line_items: ShopifyLineItem[];
  // Neither of these are native Shopify order fields — the checkout
  // integration this store uses (Appmax) injects them as note_attributes
  // when it captures Brazil-specific checkout data. Not every order has
  // them (depends on checkout flow/store), so both are optional.
  note_attributes?: { name: string; value: string }[];
  // Present on both the REST GET response and the orders/paid|updated
  // webhook payload — used to recover the tracking code/carrier for an
  // order fulfilled entirely outside this system (see shopify-webhook).
  fulfillments?: { status: string; tracking_company: string | null; tracking_number: string | null }[];
}

// The most recent successful fulfillment's tracking info, or nulls if the
// order has none (not yet fulfilled, or fulfilled with no tracking entered).
export function latestFulfillmentTracking(order: ShopifyOrder): { trackingCode: string | null; trackingCompany: string | null } {
  const successful = (order.fulfillments ?? []).filter((f) => f.status === "success");
  const latest = successful[successful.length - 1];
  return { trackingCode: latest?.tracking_number ?? null, trackingCompany: latest?.tracking_company ?? null };
}

export interface ShopifyOrdersListResponse {
  orders: ShopifyOrder[];
}

export interface FulfillmentTrackingInfo {
  number: string;
  company: string;
  url?: string;
}

export interface CreateFulfillmentInput {
  shopifyOrderGraphqlId: string;
  trackingInfo: FulfillmentTrackingInfo;
  notifyCustomer?: boolean;
}

export interface OrderItemSnapshot {
  shopifyLineItemId: number;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  grams: number;
}

export interface OrderCandidate {
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  shopifyGraphqlId: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  totalPrice: string;
  paidAt: Date | null;
  items: OrderItemSnapshot[];
  shippingAddress: Record<string, unknown> | null;
}

function noteAttribute(order: ShopifyOrder, name: string): string | undefined {
  return order.note_attributes?.find((attr) => attr.name === name)?.value || undefined;
}

export async function mapShopifyOrderToCandidate(order: ShopifyOrder, store: StoreConfig): Promise<OrderCandidate> {
  const customerName = order.customer
    ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(" ") || null
    : order.shipping_address?.name ?? null;

  // Melhor Envio requires the recipient's CPF/CNPJ (Brazil-wide anti-fraud
  // rule for e-commerce parcels) and a bairro/district, neither of which
  // Shopify's own address model has fields for. This store's checkout
  // integration (Appmax) injects them as note_attributes when it captures
  // that data — not every order has it (see buildCartPayload's
  // MissingRecipientDocumentError for what happens when it's absent).
  const shippingAddress = order.shipping_address
    ? {
        ...order.shipping_address,
        document: noteAttribute(order, "customer_document"),
        neighborhood: noteAttribute(order, "shipping_neighborhood") ?? noteAttribute(order, "billing_neighborhood"),
      }
    : null;

  const shopifyGraphqlId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;
  const current = await fetchCurrentOrderState(store, shopifyGraphqlId);

  // REST's line_items[].quantity is the ORIGINALLY ordered quantity — it
  // stays put even after Shopify's own Order Edit feature removes/swaps an
  // item (e.g. Vitor changing a variant on the order), which only shows up
  // via GraphQL's currentQuantity. Left uncorrected, a swapped-out item
  // would still get packed/shipped/declared. Items edited down to 0 are
  // dropped entirely instead of listed as "0x".
  const items = order.line_items
    .map((item) => ({
      shopifyLineItemId: item.id,
      title: item.title,
      variantTitle: item.variant_title,
      sku: item.sku,
      quantity: current.quantities.get(item.id) ?? item.quantity,
      unitPrice: item.price,
      grams: item.grams,
    }))
    .filter((item) => item.quantity > 0);

  return {
    shopifyOrderId: String(order.id),
    shopifyOrderNumber: String(order.order_number),
    shopifyGraphqlId,
    financialStatus: order.financial_status,
    fulfillmentStatus: order.fulfillment_status,
    customerName,
    customerEmail: order.customer?.email ?? order.email ?? null,
    currency: order.currency ?? "BRL",
    totalPrice: current.totalPrice ?? order.total_price,
    paidAt: order.processed_at ? new Date(order.processed_at) : null,
    items,
    shippingAddress,
  };
}

export async function verifyShopifyHmac(
  rawBody: Uint8Array,
  hmacHeader: string | undefined | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(rawBody).buffer as ArrayBuffer);
  const digest = base64Encode(new Uint8Array(signature));

  const digestBytes = new TextEncoder().encode(digest);
  const headerBytes = new TextEncoder().encode(hmacHeader);
  if (digestBytes.length !== headerBytes.length) return false;
  return timingSafeEqual(digestBytes, headerBytes);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function logInvalidWebhook(topic: string) {
  console.log(JSON.stringify({ level: "warn", topic, msg: "shopify_webhook_invalid_hmac" }));
}

function baseUrl(store: StoreConfig): string {
  return `https://${store.shopDomain}/admin/api/${store.apiVersion}`;
}

export class ShopifyApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = status;
    this.body = body;
  }
}

// Custom apps created via the current Shopify dev dashboard only support
// the OAuth client_credentials grant, which issues a short-lived (~24h)
// access token — there is no long-lived static token to store. A fresh
// token is fetched on every call instead of caching one, since Edge
// Functions are short-lived/stateless and tracking expiry across
// invocations would add complexity for a negligible extra request.
async function fetchAccessToken(store: StoreConfig): Promise<string> {
  const response = await fetch(`https://${store.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: store.clientId,
      client_secret: store.clientSecret,
      grant_type: "client_credentials",
    }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok || !body?.access_token) {
    throw new ShopifyApiError(`Failed to obtain Shopify access token (${response.status})`, response.status, body);
  }
  return body.access_token as string;
}

async function shopifyFetchRaw(
  store: StoreConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ body: unknown; linkHeader: string | null }> {
  const accessToken = await fetchAccessToken(store);
  const url = path.startsWith("http") ? path : `${baseUrl(store)}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new ShopifyApiError(`Shopify API error ${response.status}`, response.status, body);
  }
  return { body, linkHeader: response.headers.get("link") };
}

async function shopifyFetch<T>(store: StoreConfig, path: string, init: RequestInit = {}): Promise<T> {
  const { body } = await shopifyFetchRaw(store, path, init);
  return body as T;
}

// Shopify's REST list endpoints paginate via a cursor URL in the Link
// header (`<url>; rel="next"`), not an offset -- this pulls it out, or null
// once the last page is reached.
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(",").map((part) => part.trim()).find((part) => part.endsWith('rel="next"'));
  const match = nextPart?.match(/^<([^>]+)>/);
  return match ? match[1] : null;
}

function isRetryableStatus(error: unknown): boolean {
  if (error instanceof ShopifyApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

// GraphQL is preferred for fulfillment creation; REST is used for the
// reconciliation list fetch since it maps 1:1 to the query params in the spec.
export async function fetchPaidUnfulfilledOrders(
  store: StoreConfig,
  params?: { updatedAtMin?: string },
): Promise<ShopifyOrder[]> {
  const search = new URLSearchParams({
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    status: "any",
    limit: "250",
  });
  if (params?.updatedAtMin) {
    search.set("updated_at_min", params.updatedAtMin);
  }

  return withRetry(
    async () => {
      const data = await shopifyFetch<ShopifyOrdersListResponse>(store, `/orders.json?${search.toString()}`);
      return data.orders;
    },
    { label: "shopify.fetchPaidUnfulfilledOrders", isRetryable: isRetryableStatus },
  );
}

// One-off backfill for orders fulfilled outside this system before the
// "external" recording existed (or from any webhook delivery that was
// missed) -- paginates through every matching page instead of just the
// first 250, since a real backfill window can easily exceed that.
export async function fetchPaidFulfilledOrders(
  store: StoreConfig,
  params?: { createdAtMin?: string },
): Promise<ShopifyOrder[]> {
  const search = new URLSearchParams({
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    status: "any",
    limit: "250",
  });
  if (params?.createdAtMin) {
    search.set("created_at_min", params.createdAtMin);
  }

  const orders: ShopifyOrder[] = [];
  let path: string | null = `/orders.json?${search.toString()}`;
  let pagesFetched = 0;
  const maxPages = 40; // hard cap ~10k orders, just to bound a runaway loop

  while (path && pagesFetched < maxPages) {
    const currentPath: string = path;
    const { body, linkHeader } = await withRetry(
      () => shopifyFetchRaw(store, currentPath),
      { label: "shopify.fetchPaidFulfilledOrders", isRetryable: isRetryableStatus },
    );
    orders.push(...(body as ShopifyOrdersListResponse).orders);
    path = parseNextLink(linkHeader);
    pagesFetched += 1;
  }

  return orders;
}

export async function fetchOrderById(store: StoreConfig, shopifyOrderId: string): Promise<ShopifyOrder> {
  return withRetry(
    async () => {
      const data = await shopifyFetch<{ order: ShopifyOrder }>(store, `/orders/${shopifyOrderId}.json`);
      return data.order;
    },
    { label: "shopify.fetchOrderById", isRetryable: isRetryableStatus },
  );
}

interface FulfillmentCreateV2Response {
  data?: {
    fulfillmentCreateV2?: {
      fulfillment?: { id: string; status: string; trackingInfo: { number: string; url: string }[] };
      userErrors: { field: string[]; message: string }[];
    };
  };
  errors?: unknown[];
}

const FULFILLMENT_ORDER_QUERY = `
  query GetFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        edges { node { id status } }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number url }
      }
      userErrors { field message }
    }
  }
`;

async function graphql<T>(store: StoreConfig, query: string, variables: Record<string, unknown>): Promise<T> {
  return shopifyFetch<T>(store, "/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
}

const LOCALIZATION_EXTENSIONS_QUERY = `
  query GetLocalizationExtensions($orderId: ID!) {
    order(id: $orderId) {
      localizationExtensions(first: 10) {
        edges { node { key value purpose countryCode } }
      }
    }
  }
`;

interface LocalizationExtensionsResponse {
  data?: {
    order?: {
      localizationExtensions?: { edges: { node: { key: string; value: string; purpose: string; countryCode: string } }[] };
    };
  };
}

const ORDER_CURRENT_STATE_QUERY = `
  query GetCurrentOrderState($orderId: ID!) {
    order(id: $orderId) {
      currentTotalPriceSet { shopMoney { amount } }
      lineItems(first: 250) {
        edges { node { id currentQuantity } }
      }
    }
  }
`;

interface CurrentOrderStateResponse {
  data?: {
    order?: {
      currentTotalPriceSet?: { shopMoney?: { amount?: string } };
      lineItems?: { edges: { node: { id: string; currentQuantity: number } }[] };
    };
  };
}

// See mapShopifyOrderToCandidate for why this is needed: REST's
// line_items[].quantity and total_price both go stale once an order is
// edited in Shopify (swap/remove a line item) — only GraphQL's
// currentQuantity/currentTotalPriceSet reflect what's actually on the order.
async function fetchCurrentOrderState(
  store: StoreConfig,
  shopifyGraphqlId: string,
): Promise<{ quantities: Map<number, number>; totalPrice: string | undefined }> {
  const result = await withRetry(
    () => graphql<CurrentOrderStateResponse>(store, ORDER_CURRENT_STATE_QUERY, { orderId: shopifyGraphqlId }),
    { label: "shopify.fetchCurrentOrderState", isRetryable: isRetryableStatus },
  );
  const edges = result.data?.order?.lineItems?.edges ?? [];
  const quantities = new Map<number, number>();
  for (const edge of edges) {
    const numericId = Number(edge.node.id.split("/").pop());
    quantities.set(numericId, edge.node.currentQuantity);
  }
  return { quantities, totalPrice: result.data?.order?.currentTotalPriceSet?.shopMoney?.amount };
}

// Brazil's recipient CPF/CNPJ ("Informacoes adicionais" in the Shopify
// order admin UI) isn't a REST order field or a note_attribute — it's only
// reachable via this GraphQL extension, under key TAX_CREDENTIAL_BR. Called
// live at cart-build time rather than baked into the webhook/reconciliation
// snapshot, since neither of those sources carry it either.
export async function fetchRecipientTaxCredential(store: StoreConfig, shopifyGraphqlId: string): Promise<string | undefined> {
  const result = await withRetry(
    () => graphql<LocalizationExtensionsResponse>(store, LOCALIZATION_EXTENSIONS_QUERY, { orderId: shopifyGraphqlId }),
    { label: "shopify.fetchRecipientTaxCredential", isRetryable: isRetryableStatus },
  );
  const edges = result.data?.order?.localizationExtensions?.edges ?? [];
  const taxCredential = edges.find((edge) => edge.node.key === "TAX_CREDENTIAL_BR")?.node.value;
  return taxCredential?.replace(/\D/g, "") || undefined;
}

// Creates a Fulfillment carrying the tracking code so Shopify fires its own
// customer notification email automatically.
export async function createFulfillment(
  store: StoreConfig,
  input: CreateFulfillmentInput,
): Promise<{ fulfillmentId: string }> {
  return withRetry(
    async () => {
      const fulfillmentOrdersResult = await graphql<{
        data?: { order?: { fulfillmentOrders?: { edges: { node: { id: string; status: string } }[] } } };
      }>(store, FULFILLMENT_ORDER_QUERY, { orderId: input.shopifyOrderGraphqlId });

      const edges = fulfillmentOrdersResult.data?.order?.fulfillmentOrders?.edges ?? [];
      const openFulfillmentOrder = edges.find((edge) => edge.node.status === "OPEN") ?? edges[0];
      if (!openFulfillmentOrder) {
        throw new Error(`No fulfillment order found for ${input.shopifyOrderGraphqlId}`);
      }

      const result = await graphql<FulfillmentCreateV2Response>(store, FULFILLMENT_CREATE_MUTATION, {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFulfillmentOrder.node.id }],
          trackingInfo: {
            number: input.trackingInfo.number,
            company: input.trackingInfo.company,
            url: input.trackingInfo.url,
          },
          notifyCustomer: input.notifyCustomer ?? true,
        },
      });

      const userErrors = result.data?.fulfillmentCreateV2?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(`fulfillmentCreateV2 userErrors: ${JSON.stringify(userErrors)}`);
      }

      const fulfillmentId = result.data?.fulfillmentCreateV2?.fulfillment?.id;
      if (!fulfillmentId) {
        throw new Error("fulfillmentCreateV2 returned no fulfillment id");
      }
      console.log(JSON.stringify({ fulfillmentId, order: input.shopifyOrderGraphqlId, msg: "shopify_fulfillment_created" }));
      return { fulfillmentId };
    },
    { label: "shopify.createFulfillment", isRetryable: isRetryableStatus },
  );
}
