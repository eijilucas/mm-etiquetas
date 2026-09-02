import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";
import { signHmacHex } from "./hmac.ts";
import { withRetry } from "./retry.ts";
import type { OrderShippingRow } from "./db.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

interface ShippingCallbackEvent {
  sourceOrderId: string;
  event: string;
  status: string;
  metadata?: Record<string, unknown>;
}

// Dispara o callback assinado (contrato 04-shipping-callback.md) pro
// mental-madness-vendas-externas. Best-effort com retry (diferente do
// callback fire-and-forget que já existe pra mental-madness-estoque em
// _shared/estoque.ts) — falha permanente aqui não deve travar o pipeline
// de etiqueta em si, só fica sem avisar o cliente por e-mail (alguém
// percebe pela ausência do aviso, ou reprocessa manualmente depois).
export async function sendShippingCallback(config: AppConfig, event: ShippingCallbackEvent): Promise<void> {
  const { url, secret } = config.integrationCallback;
  if (!url || !secret) {
    log({ sourceOrderId: event.sourceOrderId, event: event.event }, "integration_callback_not_configured_skipping");
    return;
  }

  const payload = {
    eventId: crypto.randomUUID(),
    sourceOrderId: event.sourceOrderId,
    event: event.event,
    status: event.status,
    occurredAt: new Date().toISOString(),
    metadata: event.metadata ?? {},
  };
  const rawBody = JSON.stringify(payload);
  const signature = await signHmacHex(rawBody, secret);

  try {
    await withRetry(
      async () => {
        const res = await fetch(`${url}/functions/v1/integration-callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": signature,
          },
          body: rawBody,
        });
        if (!res.ok) {
          throw new Error(`integration-callback respondeu ${res.status}: ${await res.text()}`);
        }
      },
      { label: "integration_callback", attempts: 3 },
    );
    log({ sourceOrderId: event.sourceOrderId, event: event.event }, "integration_callback_succeeded");
  } catch (err) {
    log({ sourceOrderId: event.sourceOrderId, event: event.event, err: String(err) }, "integration_callback_failed_permanently");
  }
}

// Avisa o Vendas Externas sempre que o status (ou posted_at) de um pedido
// externo muda — alimenta as abas Fila de aprovação/Liberados/Rastreio/
// Postados de lá, que hoje não têm nenhuma visibilidade sobre o pipeline
// daqui além de "foi aceito ou não". No-op silencioso pra pedidos não
// externos (store_key !== "external") — chamar isso de qualquer lugar do
// pipeline sem guarda extra no call site é seguro.
export async function reportExternalStageChange(
  config: AppConfig,
  order: Pick<OrderShippingRow, "store_key" | "shopify_order_id" | "status" | "posted_at">,
): Promise<void> {
  if (order.store_key !== "external") return;
  await sendShippingCallback(config, {
    sourceOrderId: order.shopify_order_id,
    event: "shipping.status_changed",
    status: order.status,
    metadata: { postedAt: order.posted_at ?? null },
  });
}

// Mesma coisa que reportExternalStageChange, mas a partir de uma lista de
// ids — usada pelos pontos que mudam status/posted_at em lote sem já ter
// as linhas completas em mãos (/hold, /post, /revert em orders-api,
// syncPostedOrders em reconciliation.ts). Nunca lança: uma falha aqui não
// pode derrubar uma ação que já teve sucesso, nem um loop de cron sem
// try/catch por iteração.
export async function reportExternalStageChangeForIds(
  supabase: SupabaseClient,
  config: AppConfig,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { data, error } = await supabase
      .from("orders_shipping")
      .select("store_key, shopify_order_id, status, posted_at")
      .in("id", ids)
      .eq("store_key", "external");
    if (error) throw error;
    for (const row of (data ?? []) as Pick<OrderShippingRow, "store_key" | "shopify_order_id" | "status" | "posted_at">[]) {
      await reportExternalStageChange(config, row);
    }
  } catch (err) {
    console.log(JSON.stringify({ level: "error", err: String(err), ids, msg: "stage_change_report_failed" }));
  }
}
