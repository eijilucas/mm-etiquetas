import type { ShopifyOrder } from "./types";

export interface OrderItemSnapshot {
  shopifyLineItemId: number;
  title: string;
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

export function mapShopifyOrderToCandidate(order: ShopifyOrder): OrderCandidate {
  const customerName = order.customer
    ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(" ") || null
    : order.shipping_address?.name ?? null;

  return {
    shopifyOrderId: String(order.id),
    shopifyOrderNumber: String(order.order_number),
    shopifyGraphqlId: order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`,
    financialStatus: order.financial_status,
    fulfillmentStatus: order.fulfillment_status,
    customerName,
    customerEmail: order.customer?.email ?? order.email ?? null,
    currency: order.currency ?? "BRL",
    totalPrice: order.total_price,
    paidAt: order.processed_at ? new Date(order.processed_at) : null,
    items: order.line_items.map((item) => ({
      shopifyLineItemId: item.id,
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.price,
      grams: item.grams,
    })),
    shippingAddress: order.shipping_address ? { ...order.shipping_address } : null,
  };
}
