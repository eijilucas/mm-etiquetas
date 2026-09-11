import type { AppConfig } from "./config.ts";
import { signHmacHex } from "./hmac.ts";
import { withRetry } from "./retry.ts";
import type { OrderShippingRow } from "./db.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

// Empurra o custo real da etiqueta pro mental-lucro-liquido, que calcula o
// resultado do frete por pedido = frete cobrado do cliente (Shopify) −
// frete real pago (o shipping_price daqui). Espelha integrationCallback.ts:
// best-effort com retry, falha permanente só loga, nunca trava o pipeline
// de etiqueta. Fica dormente até LUCRO_LIQUIDO_CALLBACK_SECRET ser setado.
//
// A function do lado de lá vai com verify_jwt = false — o HMAC no header
// X-Signature (SHA-256 hex do corpo cru) é a única autenticação, por isso
// não manda Authorization.
//
// valor_frete e diferenca_frete são independentes: cada chamador manda só o
// que tem (reportShippingCost manda só valor_frete; reportShippingCostDifference,
// só diferenca_frete) — JSON.stringify já omite o campo ausente sozinho, o
// lado de lá sobrescreve só o que veio no corpo.
//
// shopify_order_id e external_order_id também são mutuamente exclusivos
// (2026-09-11, acordado com o lado do lucro-liquido): pedido normal manda
// shopify_order_id; pedido de Vendas Externas (store_key "external" aqui —
// carrega o uuid do Vendas Externas no campo shopify_order_id do nosso
// schema, não um id Shopify de verdade) manda external_order_id em vez
// disso, nunca os dois juntos.
export interface ShippingCostCallbackBody {
  shopify_order_id?: string;
  external_order_id?: string;
  order_number: string | null;
  valor_frete?: number;
  diferenca_frete?: number;
}

export async function sendShippingCostCallback(config: AppConfig, body: ShippingCostCallbackBody): Promise<void> {
  const { url, secret } = config.lucroLiquidoCallback;
  const orderIdForLog = body.shopify_order_id ?? body.external_order_id;
  if (!url || !secret) {
    log({ orderId: orderIdForLog }, "lucro_liquido_callback_not_configured_skipping");
    return;
  }

  const rawBody = JSON.stringify(body);
  const signature = await signHmacHex(rawBody, secret);

  try {
    await withRetry(
      async () => {
        const res = await fetch(`${url}/functions/v1/shipping-cost-callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": signature,
          },
          body: rawBody,
        });
        if (!res.ok) {
          throw new Error(`shipping-cost-callback respondeu ${res.status}: ${await res.text()}`);
        }
      },
      { label: "lucro_liquido_callback", attempts: 3 },
    );
    log({ orderId: orderIdForLog }, "lucro_liquido_callback_succeeded");
  } catch (err) {
    log(
      { orderId: orderIdForLog, err: String(err) },
      "lucro_liquido_callback_failed_permanently",
    );
  }
}

// Chamado no ponto de saída de runShippingPipeline. Só empurra pedido que
// já tem custo real de etiqueta (shipping_price). Pedido de Vendas Externas
// (store_key "external") manda external_order_id em vez de shopify_order_id
// -- até 2026-09-11 esses ficavam de fora inteiramente (o campo
// shopify_order_id ali é o uuid do Vendas Externas, não um id Shopify de
// verdade), mas o lado do lucro-liquido passou a aceitar essa segunda chave
// e soma o frete externo numa view separada da DRE. Roda de novo a cada
// reprocess/retry; o lado de lá faz upsert por shopify_order_id OU
// external_order_id, o que vier no corpo.
export async function reportShippingCost(
  config: AppConfig,
  order: Pick<OrderShippingRow, "store_key" | "shopify_order_id" | "shopify_order_number" | "shipping_price">,
): Promise<void> {
  if (order.shipping_price == null) return;
  await sendShippingCostCallback(config, {
    ...(order.store_key === "external"
      ? { external_order_id: order.shopify_order_id }
      : { shopify_order_id: order.shopify_order_id }),
    valor_frete: order.shipping_price,
    order_number: order.shopify_order_number,
  });
}

// Chamado pelo cron diário de conciliação (syncShippingCostDifferences em
// reconciliation.ts) — diferenca é o total ACUMULADO de diferença daquele
// pedido (não um delta), o lado de lá sobrescreve o campo em vez de somar.
// Manda só diferenca_frete, nunca valor_frete (esses dois nunca vêm juntos
// nesse cron).
export async function reportShippingCostDifference(
  config: AppConfig,
  order: { shopify_order_id: string; shopify_order_number: string | null; diferenca_frete: number },
): Promise<void> {
  await sendShippingCostCallback(config, {
    shopify_order_id: order.shopify_order_id,
    order_number: order.shopify_order_number,
    diferenca_frete: order.diferenca_frete,
  });
}
