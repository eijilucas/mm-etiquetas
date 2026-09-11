-- Segundo job de pg_cron, na MESMA URL/secret do job de reconciliação, só
-- que uma vez por dia e com um corpo diferente, que
-- reconciliation-cron/index.ts usa pra decidir qual bloco rodar em vez de
-- ser uma function/schedule separada. Motivo: esse ambiente não consegue
-- rodar `supabase db push` (sem SUPABASE_DB_PASSWORD), então uma migração
-- normal nunca chega no banco de produção sozinha -- este arquivo é só o
-- registro do que foi rodado manualmente no SQL Editor do Supabase, não
-- algo que se auto-aplica.
--
-- Este projeto usa a variante de "valores diretos" (ver README.md, "Passo
-- manual obrigatorio pos-deploy") porque `alter database set
-- app.settings.*` não tem permissão aqui -- então, ao contrário de
-- 0002_pg_cron.sql, a URL e o secret vão hardcoded no corpo do job, não via
-- current_setting(). Troque <project-ref> e <CRON_SECRET> pelos valores
-- reais antes de rodar.
--
-- Horário: 06:00 UTC (03:00 America/Sao_Paulo) -- fora do horário comercial,
-- depois que qualquer postagem do dia anterior já teve tempo de ser
-- conferida pela transportadora.
insert into cron_locks (name, running_since) values ('melhorenvio_conciliation', null)
  on conflict (name) do nothing;

select cron.schedule(
  'melhorenvio-conciliation-daily',
  '0 6 * * *',
  $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/reconciliation-cron',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{"job": "melhorenvio_conciliation"}'::jsonb
  );
  $job$
);
