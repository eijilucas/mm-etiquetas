export interface ShopifyMoney {
  amount: string;
  currency_code?: string;
}

export interface ShopifyLineItem {
  id: number;
  title: string;
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
