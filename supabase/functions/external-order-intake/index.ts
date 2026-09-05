// Recebe pedido do sistema de Vendas Externas (WhatsApp/Discord/Instagram —
// nunca passa pelo checkout da Shopify) e entra na MESMA fila de aprovação
// dos pedidos Shopify normais, como store_key "external" — reaproveita
// upsertPendingCandidate tal e qual (mesma semântica de "held fica de fora",
// "já em pipeline não regride pra pending_approval").
//
// shopify_order_id guarda o id do pedido no Vendas Externas (uuid) — é o que
// garante idempotência (reenvio do mesmo pedido nunca duplica a linha) e é
// como runShippingPipeline mais adiante identifica "isso é externo" (ver
// pipeline.ts: order.store_key === "external").
//
// endereço/itens já chegam formatados no MESMO formato que toAddress() /
// buildCartPayload() (em pipeline.ts) esperam de um pedido Shopify — assim
// nenhum código do pipeline downstream precisa saber a origem do pedido.

import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { createServiceClient, upsertPendingCandidate } from "../_shared/db.ts";
import type { ShippingStatus } from "../_shared/db.ts";
import type { OrderCandidate, OrderItemSnapshot } from "../_shared/shopify.ts";
import { cancelOrderLabel } from "../_shared/pipeline.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Mesma lista de orders-api/index.ts (PROCESSING_STATUSES) — duplicada aqui
// em vez de importada porque aquele arquivo não exporta o array; são as
// únicas duas edge functions que precisam dela e diverge raramente o
// suficiente pra não valer o refactor agora.
const PROCESSING_STATUSES: ShippingStatus[] = [
  "approved",
  "cart_created",
  "purchased",
  "label_generated",
  "tracking_ready",
  "tracking_synced",
  "failed",
];

export interface Deps {
  config?: AppConfig;
  supabase?: SupabaseClient;
}

interface ExternalItemInput {
  itemId: string;
  title: string;
  productId: string | null;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPrice: string;
}

interface ExternalOrderInput {
  externalOrderId: string;
  publicNumber: number;
  customerName: string;
  customerEmail?: string | null;
  customerDocument: string;
  customerPhone?: string | null;
  totalPrice: string;
  address: {
    street: string;
    number: string;
    complement?: string | null;
    district: string;
    city: string;
    state: string;
    cep: string;
  };
  items: ExternalItemInput[];
  dropId?: string | null;
  dropName?: string | null;
}

function isAuthorized(req: Request, config: AppConfig): boolean {
  const expected = config.externalOrders.secret;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(expected) && got === expected;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Espelha a exclusão de um pedido no Vendas Externas — chamado por
// delete-order de lá sempre que um pedido é apagado do painel (contrato:
// docs/api-contracts/06-external-order-delete.md). Idempotente: pedido já
// arquivado, ou nunca encontrado aqui (ex.: falhou na criação e nunca
// chegou a entrar na fila), respondem ok sem erro — apagar do lado de lá
// não pode travar em cima de um estado que já não existe deste lado.
async function handleCancel(req: Request, config: AppConfig, deps: Deps): Promise<Response> {
  let body: { externalOrderId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!body.externalOrderId) {
    return jsonResponse({ error: "external_order_id_required" }, 400);
  }

  const supabase = deps.supabase ?? createServiceClient(config);
  const reason = body.reason || "Pedido excluído no Vendas Externas";

  const { data: row, error: findError } = await supabase
    .from("orders_shipping")
    .select("id, status")
    .eq("store_key", "external")
    .eq("shopify_order_id", body.externalOrderId)
    .maybeSingle();

  if (findError) {
    console.log(JSON.stringify({ level: "error", err: String(findError), externalOrderId: body.externalOrderId, msg: "external_order_cancel_lookup_failed" }));
    return jsonResponse({ error: "lookup_failed" }, 500);
  }
  if (!row) {
    return jsonResponse({ ok: true, found: false });
  }
  if (row.status === "archived") {
    return jsonResponse({ ok: true, found: true, finalStatus: "archived", already: true });
  }

  try {
    // Ainda não saiu de pending_approval/held: nada foi comprado na Melhor
    // Envio, nem baixa de estoque foi reportada — só arquiva direto, sem
    // passar pelas travas de status do /cancel e /archive do painel
    // humano (que existem pra impedir clique errado de operador, não se
    // aplicam a essa sincronização automática).
    if (PROCESSING_STATUSES.includes(row.status)) {
      await cancelOrderLabel(supabase, config, row.id, reason);
    }
    const { error: archiveError } = await supabase
      .from("orders_shipping")
      .update({ status: "archived", archived_at: new Date().toISOString(), archived_by: "vendas-externas-sync" })
      .eq("id", row.id);
    if (archiveError) throw archiveError;
    return jsonResponse({ ok: true, found: true, finalStatus: "archived" });
  } catch (error) {
    console.log(
      JSON.stringify({ level: "error", err: String(error), externalOrderId: body.externalOrderId, msg: "external_order_cancel_failed" }),
    );
    return jsonResponse({ error: "processing_failed" }, 500);
  }
}

async function handleCreate(req: Request, config: AppConfig, deps: Deps): Promise<Response> {
  let body: ExternalOrderInput;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (!body.externalOrderId || !body.customerDocument || !Array.isArray(body.items) || body.items.length === 0) {
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }

  // Mesmo truque de "número, vírgula" que os checkouts Shopify reais usam
  // (ver splitAddressAndNumber em pipeline.ts) — assim toAddress() extrai o
  // número certo sem precisar de nenhum código específico pra pedido
  // externo. Mesma lógica pro bairro via address2 (splitComplementAndDistrict).
  const address1 = `${body.address.street}, ${body.address.number}`;
  const address2 = [body.address.complement, body.address.district].filter(Boolean).join(", ");

  const items: OrderItemSnapshot[] = body.items.map((item) => ({
    // shopifyLineItemId não existe de verdade aqui — o itemId do Vendas
    // Externas (uuid) faz o mesmo papel de identificador estável do item,
    // usado depois pra reportar baixa de estoque (ver _shared/estoque.ts).
    shopifyLineItemId: item.itemId as unknown as number,
    title: item.title,
    variantTitle: [item.size, item.color].filter(Boolean).join(" / ") || null,
    sku: item.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    grams: 0,
  }));

  const candidate: OrderCandidate = {
    shopifyOrderId: body.externalOrderId,
    shopifyOrderNumber: `VE-${body.publicNumber}`,
    shopifyGraphqlId: "",
    financialStatus: "paid",
    fulfillmentStatus: null,
    customerName: body.customerName,
    customerEmail: body.customerEmail ?? null,
    currency: "BRL",
    totalPrice: body.totalPrice,
    paidAt: new Date(),
    items,
    shippingAddress: {
      name: body.customerName,
      address1,
      address2,
      city: body.address.city,
      province_code: body.address.state,
      zip: body.address.cep,
      country_code: "BR",
      phone: body.customerPhone ?? null,
      document: body.customerDocument,
    },
    dropId: body.dropId ?? null,
    dropName: body.dropName ?? null,
  };

  const supabase = deps.supabase ?? createServiceClient(config);

  try {
    const row = await upsertPendingCandidate(supabase, candidate, "external");
    return jsonResponse({ ok: true, id: row.id, status: row.status });
  } catch (error) {
    console.log(
      JSON.stringify({ level: "error", err: String(error), externalOrderId: body.externalOrderId, msg: "external_order_intake_failed" }),
    );
    return jsonResponse({ error: "processing_failed" }, 500);
  }
}

export async function handleExternalOrderIntake(req: Request, deps: Deps = {}): Promise<Response> {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const config = deps.config ?? loadConfig();
  if (!isAuthorized(req, config)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  return req.method === "DELETE" ? handleCancel(req, config, deps) : handleCreate(req, config, deps);
}

if (import.meta.main) {
  Deno.serve((req) => handleExternalOrderIntake(req));
}
