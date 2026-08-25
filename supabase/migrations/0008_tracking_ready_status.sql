-- Decouples "we have the tracking code" from "the customer was notified".
-- Previously syncTrackingStep fetched the code from Melhor Envio and
-- immediately called Shopify's fulfillmentCreateV2 (which fires the
-- customer notification email) in the same automated step, on every 15min
-- cron cycle, with no human in the loop. Now syncTrackingStep only fetches
-- and stores the code, landing the order in "tracking_ready" — sending it
-- to Shopify (and notifying the customer) requires an explicit click on
-- Enviar in the Rastreio manual tab, via the same code path already used
-- for hand-entered tracking codes.
alter type shipping_status add value 'tracking_ready';
