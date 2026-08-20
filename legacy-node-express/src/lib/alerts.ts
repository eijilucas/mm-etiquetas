import { config } from "../config";
import { logger } from "./logger";

export async function sendAlert(text: string): Promise<void> {
  if (!config.alerts.webhookUrl) {
    logger.warn({ text }, "alert_webhook_not_configured");
    return;
  }
  try {
    await fetch(config.alerts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    logger.error({ err: error }, "alert_webhook_send_failed");
  }
}
