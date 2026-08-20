create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- The project URL and cron secret are not known at migration time (they
-- depend on the Supabase project the user links/creates), so they are read
-- from Postgres custom settings instead of being hardcoded here. These MUST
-- be set once after deploy via the Supabase SQL editor — see README.md,
-- section "Passo manual obrigatorio pos-deploy":
--   alter database postgres set app.settings.reconciliation_url = 'https://<project-ref>.supabase.co/functions/v1/reconciliation-cron';
--   alter database postgres set app.settings.cron_secret = '<same value as the CRON_SECRET secret>';
-- Until that runs, current_setting(..., true) returns null and the job below
-- performs a harmless no-op POST to nothing (net.http_post skips gracefully
-- caught by the WHERE guard).

-- Reconciliation also folds the "stuck order" alert check into the same run
-- (see supabase/functions/reconciliation-cron/index.ts) rather than using a
-- second scheduled job — one fewer moving cron piece to keep in sync.
select
  cron.schedule(
    'reconciliation-every-15-minutes',
    '*/15 * * * *',
    $$
    select
      net.http_post(
        url := current_setting('app.settings.reconciliation_url', true),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', current_setting('app.settings.cron_secret', true)
        ),
        body := '{}'::jsonb
      )
    where current_setting('app.settings.reconciliation_url', true) is not null
      and current_setting('app.settings.cron_secret', true) is not null;
    $$
  );
