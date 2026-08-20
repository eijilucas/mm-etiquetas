import { prisma } from "../db/prisma";
import { config } from "../config";
import { logger } from "../lib/logger";
import { sendAlert } from "../lib/alerts";

const NON_TERMINAL_STATUSES = ["approved", "cart_created", "purchased", "label_generated", "failed"] as const;

// Alerts once per stuck order per scan; relies on `updatedAt` age so a
// reprocess (which touches updatedAt) naturally resets the alert window.
export async function checkStuckOrders(): Promise<void> {
  const threshold = new Date(Date.now() - config.alerts.stuckHours * 60 * 60 * 1000);
  const stuck = await prisma.orderShipping.findMany({
    where: { status: { in: [...NON_TERMINAL_STATUSES] }, updatedAt: { lt: threshold } },
  });

  for (const order of stuck) {
    logger.warn({ orderShippingId: order.id, status: order.status }, "order_stuck_alert");
    await sendAlert(
      `[mm-etiquetas] Pedido ${order.shopifyOrderNumber ?? order.shopifyOrderId} travado em "${order.status}" ha mais de ${config.alerts.stuckHours}h. Ultimo erro: ${order.lastError ?? "n/a"}`,
    );
  }
}
