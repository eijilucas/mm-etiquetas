import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger";

export function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  const digestBuf = Buffer.from(digest);
  const headerBuf = Buffer.from(hmacHeader);
  if (digestBuf.length !== headerBuf.length) return false;
  return timingSafeEqual(digestBuf, headerBuf);
}

export function logInvalidWebhook(topic: string) {
  logger.warn({ topic }, "shopify_webhook_invalid_hmac");
}
