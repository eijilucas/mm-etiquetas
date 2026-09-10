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
export async function sendShippingCostCallback(
  config: AppConfig,
  body: { shopify_order_id: string; valor_frete: number; order_number: string | null },
): Promise<void> {
  const { url, secret } = config.lucroLiquidoCallback;
  if (!url || !secret) {
    log({ shopifyOrderId: body.shopify_order_id }, "lucro_liquido_callback_not_configured_skipping");
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
    log({ shopifyOrderId: body.shopify_order_id }, "lucro_liquido_callback_succeeded");
  } catch (err) {
    log(
      { shopifyOrderId: body.shopify_order_id, err: String(err) },
      "lucro_liquido_callback_failed_permanently",
    );
  }
}

// Chamado no ponto de saída de runShippingPipeline. Só empurra pedido que
// já tem custo real de etiqueta (shipping_price) e que NÃO é de Vendas
// Externas — pedido externo carrega o uuid do Vendas Externas em
// shopify_order_id, não o id numérico da Shopify, então não serve pra
// casar no lucro-liquido e fica de fora dessa ponte. Roda de novo a cada
// reprocess/retry; o lado de lá faz upsert por shopify_order_id.
export async function reportShippingCost(
  config: AppConfig,
  order: Pick<OrderShippingRow, "store_key" | "shopify_order_id" | "shopify_order_number" | "shipping_price">,
): Promise<void> {
  if (order.store_key === "external") return;
  if (order.shipping_price == null) return;
  await sendShippingCostCallback(config, {
    shopify_order_id: order.shopify_order_id,
    valor_frete: order.shipping_price,
    order_number: order.shopify_order_number,
  });
}
