-- Guards against overlapping reconciliation-cron invocations once the
-- schedule moves from every 15 minutes to every 1 minute — unlike the
-- per-order pipeline lock (processing_started_at), this run has no
-- protection against a slow cycle (e.g. scanning 140 orders, one GraphQL
-- call each) still being in flight when the next minute's tick fires,
-- which would double up Shopify/Melhor Envio API calls and raise the
-- chance of a real rate-limit hit. Single-row table, same
-- claim-with-staleness-timeout pattern as the order lock.
create table cron_locks (
  name text primary key,
  running_since timestamptz
);

insert into cron_locks (name, running_since) values ('reconciliation', null);
