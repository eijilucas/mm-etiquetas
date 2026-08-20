-- Tracks the physical hand-off to the carrier's collection point, separate
-- from the shipping_status lifecycle: a label can be "liberado" (approved
-- through tracking_synced/failed) well before someone actually drops the
-- package off, so this is its own nullable timestamp rather than another
-- shipping_status value.
alter table orders_shipping
  add column posted_at timestamptz,
  add column posted_by text;
