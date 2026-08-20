import type { StoreConfig } from "../config";
import { withRetry } from "../lib/retry";
import { logger } from "../lib/logger";
import type {
  CreateFulfillmentInput,
  ShopifyOrder,
  ShopifyOrdersListResponse,
} from "./types";

function baseUrl(store: StoreConfig): string {
  return `https://${store.shopDomain}/admin/api/${store.apiVersion}`;
}

class ShopifyApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

async function shopifyFetch<T>(store: StoreConfig, path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${baseUrl(store)}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": store.adminApiToken,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new ShopifyApiError(`Shopify API error ${response.status}`, response.status, body);
  }
  return body as T;
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
  params?: {
    updatedAtMin?: string;
  },
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

// Creates a Fulfillment carrying the tracking code so Shopify fires its own
// customer notification email automatically.
export async function createFulfillment(
  store: StoreConfig,
  input: CreateFulfillmentInput,
): Promise<{
  fulfillmentId: string;
}> {
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
      logger.info({ fulfillmentId, order: input.shopifyOrderGraphqlId }, "shopify_fulfillment_created");
      return { fulfillmentId };
    },
    { label: "shopify.createFulfillment", isRetryable: isRetryableStatus },
  );
}

export { ShopifyApiError };
