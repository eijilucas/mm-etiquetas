-- Lets a held order be permanently dismissed from every panel tab without
-- deleting the row (the audit trail — who held it, why, when — stays in the
-- DB). For orders handled entirely outside this system (e.g. #3290, a label
-- bought by hand directly on Melhor Envio's site) that don't belong in any
-- queue anymore.
alter type shipping_status add value 'archived';

alter table orders_shipping
  add column archived_at timestamptz,
  add column archived_by text;
