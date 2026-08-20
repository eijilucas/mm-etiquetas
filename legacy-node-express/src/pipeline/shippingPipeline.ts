import { prisma } from "../db/prisma";
import { logger } from "../lib/logger";
import { sendAlert } from "../lib/alerts";
import { getStoreByKey } from "../config";
import { buildCartPayload } from "./buildCartPayload";
import {
  addToCart,
  checkoutCart,
  generateLabel,
  printLabel,
  InsufficientBalanceError,
  MelhorEnvioApiError,
} from "../melhorenvio/client";
import { createFulfillment } from "../shopify/client";
import type { OrderShipping } from "@prisma/client";

// Each branch below only runs the steps still missing for the current
// status, so re-running the pipeline on a partially completed order never
// repeats an already-successful external call (idempotent by DB status).
export async function runShippingPipeline(orderShippingId: string): Promise<void> {
  let order = await prisma.orderShipping.findUniqueOrThrow({ where: { id: orderShippingId } });

  if (order.status !== "approved" && order.status !== "cart_created" && order.status !== "purchased" && order.status !== "failed") {
    logger.info({ orderShippingId, status: order.status }, "pipeline_skip_non_actionable_status");
    return;
  }

  try {
    if (order.status === "approved" || order.status === "failed") {
      order = await createCartStep(order);
    }
    if (order.status === "cart_created") {
      order = await purchaseStep(order);
    }
    if (order.status === "purchased") {
      order = await generateAndPrintLabelStep(order);
    }
    if (order.status === "label_generated") {
      order = await syncTrackingStep(order);
    }
  } catch (error) {
    await handlePipelineFailure(order, error);
  }
}

async function createCartStep(order: OrderShipping): Promise<OrderShipping> {
  if (order.melhorEnvioCartId) {
    return prisma.orderShipping.update({ where: { id: order.id }, data: { status: "cart_created" } });
  }
  const payload = await buildCartPayload(order);
  const cartItem = await addToCart(payload);
  logger.info({ orderShippingId: order.id, cartId: cartItem.id }, "pipeline_cart_created");
  return prisma.orderShipping.update({
    where: { id: order.id },
    data: { melhorEnvioCartId: cartItem.id, status: "cart_created", lastError: null },
  });
}

async function purchaseStep(order: OrderShipping): Promise<OrderShipping> {
  if (order.melhorEnvioOrderId) {
    return prisma.orderShipping.update({ where: { id: order.id }, data: { status: "purchased" } });
  }
  if (!order.melhorEnvioCartId) {
    throw new Error("Cannot purchase: missing melhorEnvioCartId");
  }
  const checkout = await checkoutCart([order.melhorEnvioCartId]);
  const purchasedOrderId = checkout.purchase?.orders?.[0]?.id ?? order.melhorEnvioCartId;
  logger.info({ orderShippingId: order.id, meOrderId: purchasedOrderId }, "pipeline_purchased");
  return prisma.orderShipping.update({
    where: { id: order.id },
    data: {
      melhorEnvioOrderId: purchasedOrderId,
      melhorEnvioProtocol: checkout.purchase?.protocol ?? null,
      status: "purchased",
      lastError: null,
    },
  });
}

async function generateAndPrintLabelStep(order: OrderShipping): Promise<OrderShipping> {
  if (!order.melhorEnvioOrderId) {
    throw new Error("Cannot generate label: missing melhorEnvioOrderId");
  }
  if (!order.labelPdfUrl) {
    await generateLabel([order.melhorEnvioOrderId]);
    const printed = await printLabel([order.melhorEnvioOrderId]);
    logger.info({ orderShippingId: order.id, url: printed.url }, "pipeline_label_generated");
    order = await prisma.orderShipping.update({
      where: { id: order.id },
      data: {
        melhorEnvioLabelId: order.melhorEnvioOrderId,
        labelPdfUrl: printed.url,
        status: "label_generated",
        lastError: null,
      },
    });
  }
  return order;
}

async function syncTrackingStep(order: OrderShipping): Promise<OrderShipping> {
  if (order.trackingCode && order.shopifyFulfillmentId) {
    return prisma.orderShipping.update({ where: { id: order.id }, data: { status: "tracking_synced" } });
  }
  // TODO: confirmar de onde vem o codigo de rastreio definitivo (resposta de
  // /me/shipment/generate costuma trazer "tracking" por pedido; usando aqui
  // o melhorEnvioOrderId como fallback caso o campo tenha outro nome).
  const trackingCode = order.trackingCode ?? order.melhorEnvioOrderId ?? "";
  if (!trackingCode) {
    throw new Error("No tracking code available to sync with Shopify");
  }

  const store = getStoreByKey(order.storeKey);
  if (!store) {
    throw new Error(`No Shopify store configured for storeKey "${order.storeKey}"`);
  }

  const fulfillment = await createFulfillment(store, {
    shopifyOrderGraphqlId: order.shopifyGraphqlId ?? `gid://shopify/Order/${order.shopifyOrderId}`,
    trackingInfo: {
      number: trackingCode,
      company: "Melhor Envio",
      url: order.labelPdfUrl ?? undefined,
    },
  });

  logger.info({ orderShippingId: order.id, fulfillmentId: fulfillment.fulfillmentId }, "pipeline_tracking_synced");
  return prisma.orderShipping.update({
    where: { id: order.id },
    data: {
      trackingCode,
      shopifyFulfillmentId: fulfillment.fulfillmentId,
      status: "tracking_synced",
      lastError: null,
    },
  });
}

async function handlePipelineFailure(order: OrderShipping, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ orderShippingId: order.id, err: error }, "pipeline_step_failed");

  await prisma.orderShipping.update({
    where: { id: order.id },
    data: { status: "failed", lastError: message },
  });

  if (error instanceof InsufficientBalanceError) {
    await sendAlert(
      `[mm-etiquetas] Pedido ${order.shopifyOrderNumber ?? order.shopifyOrderId}: saldo insuficiente na Melhor Envio.`,
    );
    return;
  }
  if (error instanceof MelhorEnvioApiError) {
    await sendAlert(
      `[mm-etiquetas] Pedido ${order.shopifyOrderNumber ?? order.shopifyOrderId}: falha na Melhor Envio (${message}).`,
    );
    return;
  }
  await sendAlert(`[mm-etiquetas] Pedido ${order.shopifyOrderNumber ?? order.shopifyOrderId}: falha no pipeline (${message}).`);
}

export async function cancelOrderLabel(orderShippingId: string, reason: string): Promise<void> {
  const order = await prisma.orderShipping.findUniqueOrThrow({ where: { id: orderShippingId } });
  if (!order.melhorEnvioOrderId) {
    logger.info({ orderShippingId }, "cancel_skipped_no_label_purchased");
    return;
  }
  const { cancelLabel } = await import("../melhorenvio/client");
  await cancelLabel([order.melhorEnvioOrderId], reason);
  await prisma.orderShipping.update({
    where: { id: order.id },
    data: { status: "held", heldReason: reason, heldAt: new Date() },
  });
}
