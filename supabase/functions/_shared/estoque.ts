import type { AppConfig } from "./config.ts";
import type { OrderItemSnapshot } from "./shopify.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

interface StockItem {
  shopifyLineItemId: number;
  quantity: number;
}

function toStockItems(items: unknown): StockItem[] {
  return (items as OrderItemSnapshot[]).map((item) => ({
    shopifyLineItemId: item.shopifyLineItemId,
    quantity: item.quantity,
  }));
}

// Both calls are best-effort: stock tracking is a secondary concern to
// actually shipping the order, so a failure here is logged and swallowed
// rather than failing the shipping pipeline. Idempotency (safe to call
// twice for the same order) is enforced on the mental-madness-estoque side,
// keyed by shopifyOrderId + shopifyLineItemId — not something this module
// needs to track.
async function postToEstoque(config: AppConfig, path: string, shopifyOrderId: string, items: unknown): Promise<void> {
  const { apiUrl, integrationSecret } = config.estoque;
  if (!apiUrl || !integrationSecret) {
    log({ shopifyOrderId, path }, "estoque_not_configured_skipping");
    return;
  }

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${integrationSecret}`,
      },
      body: JSON.stringify({ shopifyOrderId: Number(shopifyOrderId), items: toStockItems(items) }),
    });
    if (!response.ok) {
      log({ shopifyOrderId, path, status: response.status, body: await response.text() }, "estoque_call_failed");
      return;
    }
    log({ shopifyOrderId, path }, "estoque_call_succeeded");
  } catch (error) {
    log({ shopifyOrderId, path, err: String(error) }, "estoque_call_errored");
  }
}

// Called right after a label is generated — the earliest point the physical
// piece is actually spoken for, even though Shopify itself won't show the
// order as fulfilled until later in the pipeline.
export async function reportLabelGenerated(config: AppConfig, shopifyOrderId: string, items: unknown): Promise<void> {
  await postToEstoque(config, "/api/mm-etiquetas/label-generated", shopifyOrderId, items);
}

// Called after a label purchase is cancelled at Melhor Envio, to credit the
// stock back. Known gap: if the order had already reached tracking_synced
// (Shopify fulfillment already created) before cancellation, estoque's own
// periodic Shopify sync will re-derive "processado" from Shopify's
// fulfillment_status and can re-overwrite this reversal — there's no
// Shopify-fulfillment-cancel capability on the mm-etiquetas side yet.
export async function reportLabelCancelled(config: AppConfig, shopifyOrderId: string, items: unknown): Promise<void> {
  await postToEstoque(config, "/api/mm-etiquetas/label-cancelled", shopifyOrderId, items);
}
