-- Carries the Vendas Externas "drop" grouping (order_groups table over
-- there) through to mm-etiquetas, so the pending-approval queue can cluster
-- orders from the same drop together instead of listing them flat. No FK —
-- drop_id references a row in a different Supabase project (vendas-externas'
-- own DB), this side only stores it as an opaque label for grouping/display.
alter table orders_shipping add column drop_id uuid;
alter table orders_shipping add column drop_name text;
