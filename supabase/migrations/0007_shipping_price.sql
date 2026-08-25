-- Captures what Melhor Envio actually quoted for the chosen service at cart
-- creation time (POST /me/cart already returns a price field) — previously
-- only logged (melhorenvio_cheapest_service_selected), never persisted, so
-- there was no way to see freight cost per order in the panel.
alter table orders_shipping
  add column shipping_price numeric;
