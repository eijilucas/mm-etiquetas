import { config } from "../config";
import { withRetry } from "../lib/retry";
import { logger } from "../lib/logger";
import type {
  MeApiErrorBody,
  MeCalculateQuote,
  MeCalculateRequest,
  MeCancelResponse,
  MeCartItemResponse,
  MeCartRequest,
  MeCheckoutResponse,
  MeGenerateLabelResponse,
  MePrintLabelResponse,
} from "./types";

export class MelhorEnvioApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: MeApiErrorBody | undefined,
  ) {
    super(message);
    this.name = "MelhorEnvioApiError";
  }
}

export class InsufficientBalanceError extends MelhorEnvioApiError {
  constructor(status: number, body: MeApiErrorBody | undefined) {
    super("Melhor Envio: saldo insuficiente na carteira", status, body);
    this.name = "InsufficientBalanceError";
  }
}

// Melhor Envio returns generic 400/422 for wallet-balance failures; there is
// no dedicated error code documented, so this matches on message text.
// TODO: confirmar codigo/mensagem exata de erro de saldo insuficiente contra a API real (sandbox ou producao).
function isInsufficientBalanceBody(body: MeApiErrorBody | undefined): boolean {
  const message = body?.message?.toLowerCase() ?? "";
  return message.includes("saldo") || message.includes("insufficient") || message.includes("balance");
}

async function meFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.melhorEnvio.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.melhorEnvio.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.melhorEnvio.userAgent,
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    if (isInsufficientBalanceBody(body)) {
      throw new InsufficientBalanceError(response.status, body);
    }
    throw new MelhorEnvioApiError(`Melhor Envio API error ${response.status}`, response.status, body);
  }
  return body as T;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof InsufficientBalanceError) return false;
  if (error instanceof MelhorEnvioApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

export function buildFromAddress() {
  const from = config.melhorEnvio.from;
  return {
    name: from.name,
    phone: from.phone,
    email: from.email,
    document: from.document,
    postal_code: from.postalCode,
    address: from.address,
    number: from.number,
    complement: from.complement || undefined,
    district: from.district,
    city: from.city,
    state_abbr: from.stateAbbr,
  };
}

export async function calculateShipping(payload: MeCalculateRequest): Promise<MeCalculateQuote[]> {
  return withRetry(
    () => meFetch<MeCalculateQuote[]>("/me/shipment/calculate", { method: "POST", body: JSON.stringify(payload) }),
    { label: "melhorenvio.calculateShipping", isRetryable },
  );
}

export async function addToCart(payload: MeCartRequest): Promise<MeCartItemResponse> {
  return withRetry(() => meFetch<MeCartItemResponse>("/me/cart", { method: "POST", body: JSON.stringify(payload) }), {
    label: "melhorenvio.addToCart",
    isRetryable,
  });
}

export async function checkoutCart(cartItemIds: string[]): Promise<MeCheckoutResponse> {
  return withRetry(
    () =>
      meFetch<MeCheckoutResponse>("/me/shipment/checkout", {
        method: "POST",
        body: JSON.stringify({ orders: cartItemIds }),
      }),
    { label: "melhorenvio.checkoutCart", isRetryable },
  );
}

export async function generateLabel(orderIds: string[]): Promise<MeGenerateLabelResponse> {
  return withRetry(
    () =>
      meFetch<MeGenerateLabelResponse>("/me/shipment/generate", {
        method: "POST",
        body: JSON.stringify({ orders: orderIds }),
      }),
    { label: "melhorenvio.generateLabel", isRetryable },
  );
}

export async function printLabel(orderIds: string[]): Promise<MePrintLabelResponse> {
  return withRetry(
    () =>
      meFetch<MePrintLabelResponse>("/me/shipment/print", {
        method: "POST",
        body: JSON.stringify({ orders: orderIds, mode: "public" }),
      }),
    { label: "melhorenvio.printLabel", isRetryable },
  );
}

export async function cancelLabel(orderIds: string[], reason?: string): Promise<MeCancelResponse> {
  return withRetry(
    () =>
      meFetch<MeCancelResponse>("/me/shipment/cancel", {
        method: "POST",
        body: JSON.stringify({
          order: { id: orderIds },
          description: reason ?? "Pedido cancelado/reembolsado na Shopify",
          // TODO: confirmar reason_id valido exigido pela API real (endpoint /me/shipment/cancel-reasons)
          reason_id: 1,
        }),
      }),
    { label: "melhorenvio.cancelLabel", isRetryable },
  );
}

export async function fetchTrackingByOrderId(orderId: string): Promise<{ tracking?: string }> {
  return withRetry(
    () => meFetch<{ tracking?: string }>(`/me/shipment/tracking`, { method: "POST", body: JSON.stringify({ orders: [orderId] }) }),
    { label: "melhorenvio.fetchTracking", isRetryable },
  );
}

export function logCartRequest(payload: MeCartRequest, shopifyOrderId: string) {
  logger.info({ shopifyOrderId, service: payload.service, productsCount: payload.products.length }, "melhorenvio_cart_request");
}
