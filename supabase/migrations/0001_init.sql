-- Status lifecycle: pending_approval -> approved -> cart_created -> purchased
-- -> label_generated -> tracking_synced (done). "held" and "failed" are side
-- branches; held only leaves via explicit manual revert, failed via reprocess.
create type shipping_status as enum (
  'pending_approval',
  'approved',
  'cart_created',
  'purchased',
  'label_generated',
  'tracking_synced',
  'held',
  'failed'
);

create table orders_shipping (
  id uuid primary key default gen_random_uuid(),

  store_key text not null,
  shopify_order_id text not null,
  shopify_order_number text,
  shopify_graphql_id text,

  financial_status text not null,
  fulfillment_status text,

  customer_name text,
  customer_email text,
  currency text not null default 'BRL',
  total_price numeric(12, 2) not null,
  paid_at timestamptz,

  -- Line items snapshot: [{ shopifyLineItemId, title, sku, quantity, unitPrice, grams }]
  items jsonb not null,
  -- Shopify shipping address snapshot (name, address1/2, city, province_code, zip, country_code, phone)
  shipping_address jsonb not null default '{}'::jsonb,

  status shipping_status not null default 'pending_approval',
  last_error text,

  approved_by text,
  approved_at timestamptz,

  held_reason text,
  held_by text,
  held_at timestamptz,

  melhor_envio_cart_id text,
  melhor_envio_order_id text,
  melhor_envio_label_id text,
  melhor_envio_protocol text,
  tracking_code text,
  tracking_company text default 'Melhor Envio',
  label_pdf_url text,

  shopify_fulfillment_id text,

  webhook_event_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_shipping_store_order_key unique (store_key, shopify_order_id)
);

create index orders_shipping_status_idx on orders_shipping (status);
create index orders_shipping_created_at_idx on orders_shipping (created_at);
create index orders_shipping_store_key_idx on orders_shipping (store_key);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_shipping_set_updated_at
before update on orders_shipping
for each row
execute function set_updated_at();

-- Service-role only: Edge Functions use the service-role key exclusively,
-- so RLS is enabled with no policies at all (default-deny for anon/authenticated).
alter table orders_shipping enable row level security;
