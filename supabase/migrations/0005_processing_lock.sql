-- Prevents two overlapping runShippingPipeline invocations for the same
-- order (e.g. a manually-triggered reconciliation landing seconds from the
-- scheduled cron, or a double-clicked Reprocessar) from doing real work on
-- it concurrently. Without this, both runs can pass the same "already have
-- a cart / already purchased" idempotency check before either writes back,
-- and end up buying the same shipment twice — or, as happened once, a
-- losing run's failure overwriting a winning run's success. NULL means not
-- currently claimed; runShippingPipeline clears it back to NULL when done.
alter table orders_shipping
  add column processing_started_at timestamptz;
