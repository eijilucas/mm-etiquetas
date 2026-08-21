# MM Etiquetas

Orquestrador independente entre Shopify e Melhor Envio. Detecta pedidos pagos e nao processados
(via webhook `orders/paid` + reconciliacao periodica), lista os candidatos em um painel interno e
so compra o frete / gera a etiqueta quando alguem aprova manualmente. Depois de gerar a etiqueta,
grava o codigo de rastreio no pedido da Shopify (cria um `Fulfillment`), disparando a notificacao
automatica de rastreio da propria Shopify.

Suporta **multiplas lojas Shopify** (ex: "Drop Basico" e "Exclusivos") alimentando a mesma fila de
aprovacao e o mesmo pipeline — nao ha diferenca de regra de negocio entre elas no fluxo de frete, a
etapa de aprovacao manual ja cobre a incerteza de estoque de ambas. Cada pedido guarda de qual loja
veio (`storeKey`) e as chamadas de volta para a Shopify (fulfillment) usam sempre as credenciais da
loja correta.

Este sistema **nao** emite nota fiscal e **nao** integra com o Spedy — a NF-e ja e emitida
automaticamente por outro processo, totalmente separado.

**Roda 100% dentro de um projeto Supabase** — Postgres + Edge Functions + `pg_cron`. Nao ha servidor
Node separado para hospedar, nem Redis: tudo (banco, fila/agendamento, API e o painel estatico) vive
no mesmo projeto Supabase.

## Arquitetura

- **Postgres (Supabase)** — tabela `orders_shipping`, uma linha por pedido Shopify (chave unica
  composta `store_key` + `shopify_order_id`, ja que o mesmo numero de pedido pode existir em lojas
  diferentes), com o status do pipeline (`pending_approval -> approved -> cart_created -> purchased
  -> label_generated -> tracking_synced`, alem de `held` e `failed`). RLS habilitado sem policies
  publicas — apenas as Edge Functions acessam a tabela, sempre com a service-role key.
- **Edge Functions** (Deno, `supabase/functions/`):
  - `shopify-webhook` — recebe `orders/paid` e `orders/updated` de qualquer loja em
    `/functions/v1/shopify-webhook/<storeKey>`, valida o HMAC e faz upsert como `pending_approval`
    (mesmo handler pros dois topicos — o upsert so mexe em pedidos ainda `pending_approval`).
    Nunca dispara o pipeline.
  - `orders-api` — API interna (fila de aprovacao, aprovar/segurar/reverter/reprocessar). So
    `approve` e `:id/reprocess` disparam o pipeline, rodando em background via
    `EdgeRuntime.waitUntil(...)` depois de responder — substitui o BullMQ.
  - `reconciliation-cron` — busca pedidos `financial_status=paid` + `fulfillment_status=unfulfilled`
    em cada loja Shopify e faz upsert como `pending_approval`; tambem roda o alerta de "pedido
    travado" na mesma execucao. So e acionada pelo `pg_cron` (com um secret compartilhado).
  - `panel` — serve os arquivos estaticos do painel (mesmo HTML/CSS/JS de antes, so com o endpoint
    da API ajustado).
- **`pg_cron` + `pg_net`** (extensoes Postgres) — agendam uma chamada HTTP para `reconciliation-cron`
  a cada 15 minutos (ver `supabase/migrations/0002_pg_cron.sql`).

## Deploy — passo a passo

1. Instale a Supabase CLI (`npm install -g supabase` ou veja
   https://supabase.com/docs/guides/cli) e crie um projeto Supabase (plano free serve para uso leve:
   `pg_cron`/`pg_net` sao extensoes Postgres disponiveis em qualquer plano, mas um volume sustentado
   de invocacoes de Edge Functions pode eventualmente exigir um plano pago — nao e "gratis para
   sempre" sem limites, verifique o uso no dashboard).
2. Link do projeto local com o projeto Supabase criado:

   ```bash
   supabase link --project-ref <project-ref>
   ```

3. Aplique as migracoes (cria a tabela `orders_shipping` e agenda o cron):

   ```bash
   supabase db push
   ```

4. Copie `supabase/.env.example` para `supabase/.env`, preencha os valores reais (veja as secoes
   abaixo) e envie como secrets do projeto:

   ```bash
   supabase secrets set --env-file supabase/.env
   ```

5. Deploy das quatro functions:

   ```bash
   supabase functions deploy shopify-webhook
   supabase functions deploy orders-api
   supabase functions deploy reconciliation-cron
   supabase functions deploy panel
   ```

### Passo manual obrigatorio pos-deploy (nao pule este passo)

O `pg_cron` precisa saber a URL real do seu projeto e o `CRON_SECRET` para poder chamar a function
`reconciliation-cron` — isso so existe depois que o projeto foi criado, entao nao da pra deixar isso
pronto de fabrica no codigo.

Em alguns projetos Supabase, a role usada pelo SQL Editor nao tem mais privilegio de superusuario
para `alter database ... set app.settings.*` (retorna `permission denied to set parameter`, ver
`0004_pg_cron_direct_values.sql`). Nesse caso, pule direto para a alternativa abaixo. Se `alter
database` funcionar no seu projeto, pode usar a abordagem original comentada em `0002_pg_cron.sql`.

Abra o **SQL Editor** do seu projeto no dashboard da Supabase e rode (substituindo `<project-ref>`
pelo ref do seu projeto e `<CRON_SECRET>` pelo mesmo valor que voce colocou em `supabase/.env`):

```sql
select cron.unschedule('reconciliation-every-15-minutes');
select cron.schedule(
  'reconciliation-every-15-minutes',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/reconciliation-cron',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $job$
);
```

Pra conferir que pegou, rode `select jobname, schedule, active from cron.job;` e confira que
`reconciliation-every-15-minutes` aparece com `active = true`.

Sem isso, o job agendado no `pg_cron` roda a cada 15 minutos mas nao faz nada (a condicao no
`0002_pg_cron.sql` evita o POST ate essas configuracoes existirem, ou o job nem chega a existir
depois do `unschedule` acima).

## Configurando o app na Shopify

Cada loja Shopify e configurada **separadamente** — webhooks da Shopify sao por loja, e cada uma
tem seu proprio signing secret. Defina `SHOPIFY_STORE_KEYS` (ex: `basico,exclusivos`) em
`supabase/.env` e repita os passos abaixo para cada `KEY` da lista, preenchendo as variaveis
`SHOPIFY_<KEY>_*` correspondentes (veja `supabase/.env.example`).

Para cada loja:

1. No admin da loja: **Apps > Develop apps > Create an app**.
2. Em **Configuration > Admin API integration**, habilite os escopos:
   - `read_orders`
   - `write_fulfillments`
3. Instale o app e copie o **Admin API access token** gerado (`shpat_...`) para
   `SHOPIFY_<KEY>_ADMIN_API_TOKEN`.
4. Configure os webhooks `orders/paid` ("Pedido pago") e `orders/updated` ("Pedido atualizado") —
   o segundo existe pra refletir quase em tempo real quando alguem edita um pedido ainda
   `pending_approval` direto no Shopify (endereco, itens, etc.), sem depender so da reconciliacao de
   15 em 15 min:
   - Ambos apontam pro mesmo endereco:
     `https://<project-ref>.supabase.co/functions/v1/shopify-webhook/<key>` — por exemplo, com
     `SHOPIFY_STORE_KEYS=basico,exclusivos`:
     - `https://<project-ref>.supabase.co/functions/v1/shopify-webhook/basico`
     - `https://<project-ref>.supabase.co/functions/v1/shopify-webhook/exclusivos`
   - Formato: JSON.
   - O "signing secret" mostrado ali (ou o Client Secret do app) vai em
     `SHOPIFY_<KEY>_WEBHOOK_SECRET` — e usado para validar o header `X-Shopify-Hmac-Sha256`
     (HMAC-SHA256 sobre o corpo bruto da requisicao, comparado em tempo constante) especificamente
     dessa loja. Uma chave de loja desconhecida na URL responde `404 { error: "unknown_store" }`
     antes mesmo de checar o HMAC.
5. `SHOPIFY_<KEY>_SHOP_DOMAIN` e o dominio `.myshopify.com` dessa loja (sem `https://`).
6. Opcionalmente ajuste `SHOPIFY_<KEY>_API_VERSION` (formato `AAAA-MM`) se essa loja precisar de uma
   versao diferente da API — caso contrario ela usa o default global `SHOPIFY_API_VERSION`.
7. Opcionalmente defina `SHOPIFY_<KEY>_LABEL` com um nome amigavel (ex: `"Drop Basico"`) exibido no
   painel — se omitido, usa a propria chave.

### Adicionando uma terceira loja depois

Nao e preciso alterar codigo: adicione a nova chave em `SHOPIFY_STORE_KEYS`, preencha as quatro
variaveis `SHOPIFY_<NOVA_KEY>_*` (domain, token, webhook secret, e opcionalmente label/api version),
rode `supabase secrets set --env-file supabase/.env` de novo e registre os webhooks `orders/paid` e
`orders/updated` dessa loja apontando para
`https://<project-ref>.supabase.co/functions/v1/shopify-webhook/<nova-key>`.

## Autenticacao na Melhor Envio

A API v2 da Melhor Envio usa OAuth2. Para uso servidor-a-servidor sem fluxo de login interativo:

1. No painel da Melhor Envio (sandbox ou producao), va em **Gerenciar aplicacoes** / **Tokens de
   acesso** e gere um **token de longa duracao** (o "Personal Access Token" do OAuth2 da Melhor
   Envio). Copie para `MELHORENVIO_ACCESS_TOKEN`.
2. `MELHORENVIO_BASE_URL`:
   - Sandbox: `https://sandbox.melhorenvio.com.br/api/v2`
   - Producao: `https://melhorenvio.com.br/api/v2`
3. A carteira (saldo usado para comprar frete) e recarregada manualmente no painel da Melhor Envio —
   fora do escopo deste sistema. O pipeline so trata o erro de saldo insuficiente (marca o pedido
   como `failed` com `lastError` descritivo e dispara alerta).
4. `MELHORENVIO_USER_AGENT` e obrigatorio no formato `"NomeDaAplicacao (email@contato.com)"` — a
   Melhor Envio bloqueia requisicoes sem um User-Agent identificavel.
5. Escolha de transportadora: por padrao (`MELHORENVIO_AUTO_CHEAPEST=true`) o sistema chama
   `POST /me/shipment/calculate` antes de montar o carrinho e escolhe automaticamente a cotacao
   mais barata entre as validas (ignora servicos que retornam erro pra aquele destino). Use
   `MELHORENVIO_ALLOWED_SERVICE_IDS` (ex: `1,2,4`) pra restringir a comparacao a uma lista de
   transportadoras especificas, ou `MELHORENVIO_AUTO_CHEAPEST=false` pra sempre usar um servico
   fixo. `MELHORENVIO_SERVICE_ID` e o ID desse servico fixo — usado tambem como fallback se o
   calculo de frete falhar ou nao retornar nenhuma cotacao valida para o destino. Consulte
   `GET /me/shipment/services` para ver os IDs disponiveis.
6. Preencha os campos `MELHORENVIO_FROM_*` com o endereco de origem (remetente) usado em todas as
   compras de frete.
7. `MELHORENVIO_REFRESH_TOKEN` / `MELHORENVIO_CLIENT_ID` / `MELHORENVIO_CLIENT_SECRET` sao
   opcionais — deixados prontos caso voce implemente renovacao automatica de token via
   `refresh_token` mais adiante (o cliente atual usa o token de longa duracao diretamente e nao
   renova sozinho).

### Sobre dimensoes de pacote

O pedido da Shopify carrega o peso por item (`grams`), mas nao dimensoes de caixa. Por isso o
pipeline usa uma dimensao padrao configuravel via `DEFAULT_VOLUME_HEIGHT_CM` /
`DEFAULT_VOLUME_WIDTH_CM` / `DEFAULT_VOLUME_LENGTH_CM` para montar `volumes[]`. Se seu catalogo tiver
produtos com dimensoes muito diferentes entre si, isso deve ser substituido por uma fonte real de
dimensao por produto (ex: metafield na Shopify) — ha um `TODO` marcado em
`supabase/functions/_shared/pipeline.ts`.

## O painel

**A URL do painel e `https://<project-ref>.supabase.co/functions/v1/panel`** — e literalmente o
"app" que o time de operacao deve favoritar.

Ele vai pedir o `INTERNAL_API_TOKEN` (mesmo valor definido em `supabase/.env`) na primeira visita —
clique em "Configurar token".

1. **Fila de aprovacao**: lista pedidos `pending_approval`. Selecione um ou varios (checkbox ou
   "Selecionar todos") e clique em **Emitir etiquetas selecionadas** para aprovar em lote — isso
   dispara o pipeline completo (carrinho -> compra -> etiqueta -> rastreio -> fulfillment). Use
   **Segurar** para marcar como `held` quando nao ha estoque fisico; pedidos held nao voltam a
   aparecer via reconciliacao ate serem revertidos manualmente na aba "Em espera".
2. **Em processamento / Concluidos**: mostra o status atual de cada pedido aprovado. Pedidos
   `failed` tem um botao **Reprocessar**, que roda o pipeline de novo sem repetir etapas ja
   concluidas (idempotente por status).
3. **Em espera**: pedidos `held`, com botao para reverter para `pending_approval`.

## Endpoints principais

- `POST /functions/v1/shopify-webhook/<storeKey>` — recebido da Shopify, resolve a loja pelo
  `storeKey` da URL (404 `unknown_store` se nao configurada), valida o HMAC com o secret dessa loja,
  faz upsert como `pending_approval` com o `store_key` gravado. Nunca dispara o pipeline.
- `GET /functions/v1/orders-api/pending` | `/processing` | `/held` | `/:id`
- `POST /functions/v1/orders-api/approve` `{ ids: string[], approvedBy?: string }` — um dos dois
  unicos pontos que rodam o pipeline (em background, via `EdgeRuntime.waitUntil`).
- `POST /functions/v1/orders-api/hold` `{ ids: string[], reason: string, heldBy?: string }`
- `POST /functions/v1/orders-api/revert` `{ ids: string[] }` — held -> pending_approval.
- `POST /functions/v1/orders-api/:id/reprocess` — roda o pipeline de novo para um pedido `failed`
  (ou qualquer status intermediario) sem duplicar etapas ja concluidas. O outro dos dois pontos que
  disparam o pipeline.
- `POST /functions/v1/orders-api/reconciliation/run` — dispara a reconciliacao manualmente (aceita
  tanto o bearer token interno quanto o `CRON_SECRET`).

Todas as rotas de `orders-api` (exceto `reconciliation/run`, que tambem aceita o `CRON_SECRET`)
exigem `Authorization: Bearer <INTERNAL_API_TOKEN>`.

## Desenvolvimento local

```bash
supabase start             # sobe Postgres, Studio etc. localmente
supabase functions serve   # serve as Edge Functions localmente com hot-reload
```

O CLI imprime as URLs locais (Postgres, Studio, API). Use um `supabase/.env` local (nunca comitado)
para as secrets durante o desenvolvimento.

## Testes

```bash
deno test --allow-env --allow-read tests/
```

Cobre: validacao de HMAC do webhook (valido/invalido/adulterado/ausente/loja desconhecida = 404
antes do HMAC), idempotencia do upsert (webhook duplicado / held nunca reaparece / pedido ja alem de
`pending_approval` fica intocado / mesmo `shopify_order_id` em duas lojas = duas linhas), que
`pending_approval` nunca dispara o pipeline sozinho, e o caminho feliz completo (aprovacao ->
carrinho com escolha da cotacao mais barata -> compra -> etiqueta -> tracking -> fulfillment) com as
APIs externas da Shopify e da Melhor Envio mockadas via um Supabase client fake em memoria (mesmo
espirito do mock de Prisma usado nos testes Vitest da versao anterior).

## O que mudou em relacao a versao Node/Express

A versao anterior (Express + Prisma/PostgreSQL + BullMQ/Redis, rodando como processo Node
persistente) foi **arquivada** em `legacy-node-express/` e mantida so como referencia — nao recebe
mais atualizacoes. Esta e a unica versao suportada a partir de agora. As regras de negocio (fluxo de
aprovacao manual, escolha da cotacao mais barata, isolamento por loja, idempotencia do webhook e da
reconciliacao) sao identicas; o que mudou foi so o runtime: Express -> Edge Functions, Prisma ->
cliente Supabase com SQL puro, BullMQ -> `EdgeRuntime.waitUntil`, node-cron -> `pg_cron`.

## TODOs deixados no codigo

Alguns detalhes exatos de payload de resposta da API real da Melhor Envio nao estao documentados
publicamente com precisao suficiente para implementar sem risco de adivinhar errado numa integracao
financeira. Eles estao marcados com `// TODO:` em `supabase/functions/_shared/melhorenvio.ts` e
`supabase/functions/_shared/pipeline.ts` (shape exato das respostas de `/me/cart`,
`/me/shipment/checkout`, `/me/shipment/generate`, `/me/shipment/print`; codigo/mensagem exata de
saldo insuficiente; `reason_id` valido para `/me/shipment/cancel`; de qual resposta vem o codigo de
rastreio definitivo; dimensoes de pacote por produto). Rode contra o sandbox da Melhor Envio antes de
ir para producao e ajuste esses pontos com o payload real.
