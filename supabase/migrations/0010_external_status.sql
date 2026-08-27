-- Orders fulfilled entirely outside this system (bought on Melhor Envio's
-- site by hand, fulfilled directly in Shopify's admin) used to either leak
-- into pending_approval or, after the "already_fulfilled" webhook guard,
-- get silently skipped -- leaving zero record they ever existed. This
-- status gives them a place to live for visibility/history only: nothing
-- in the pipeline ever writes label/cart/purchase data for an "external"
-- order, and nothing reads it expecting a shipment to buy.
alter type shipping_status add value 'external';
