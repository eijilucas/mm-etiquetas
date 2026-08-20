import type { AppConfig } from "./config.ts";
import { withRetry } from "./retry.ts";

export interface MeAddress {
  name?: string;
  phone?: string;
  email?: string;
  document?: string;
  postal_code: string;
  address: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state_abbr: string;
  country_id?: string;
}

export interface MeProduct {
  name: string;
  quantity: number;
  unitary_value: number;
}

export interface MeVolume {
  height: number;
  width: number;
  length: number;
  weight: number;
}

export interface MeCartOptions {
  insurance_value: number;
  receipt?: boolean;
  own_hand?: boolean;
  reverse?: boolean;
  non_commercial: boolean;
  platform?: string;
  tags?: { tag: string; url?: string }[];
  reminder?: string;
}

// NOTE: options.non_commercial=true and no `invoice` field on purpose — this
// order flow never has an NF-e at label-purchase time (Spedy issues it
// separately/async), so Melhor Envio's own content declaration is used instead.
export interface MeCartRequest {
  service: number;
  agency?: number;
  from: MeAddress;
  to: MeAddress;
  products: MeProduct[];
  volumes: MeVolume[];
  options: MeCartOptions;
}

export interface MeCartItemResponse {
  id: string;
  protocol?: string;
  price?: string;
  discount?: string;
  // TODO: confirmar campos completos retornados por POST /me/cart no payload real
  [key: string]: unknown;
}

export interface MeCheckoutResponse {
  purchase: {
    id: string;
    protocol: string;
    orders: { id: string; status: string }[];
  };
  // TODO: confirmar formato exato da resposta de POST /me/shipment/checkout
  [key: string]: unknown;
}

export interface MeGenerateLabelResponse {
  status: string;
  // TODO: confirmar shape de POST /me/shipment/generate (parece variar por lote vs unitario)
  [key: string]: unknown;
}

export interface MePrintLabelResponse {
  url: string;
  // TODO: confirmar se e sempre um PDF unico ou pode ser um array multi-etiqueta
  [key: string]: unknown;
}

export interface MeCancelResponse {
  [key: string]: unknown;
}

export interface MeApiErrorBody {
  message?: string;
  errors?: Record<string, string[]>;
}

// Request body for POST /me/shipment/calculate — same shape as the cart's
// from/to/products/volumes/options, minus the `service` field, since the
// point of calling it is to get a price per service back.
export interface MeCalculateRequest {
  from: MeAddress;
  to: MeAddress;
  products: MeProduct[];
  volumes: MeVolume[];
  options?: Pick<MeCartOptions, "insurance_value" | "receipt" | "own_hand" | "reverse">;
}

export interface MeCalculateQuote {
  id: number;
  name: string;
  company?: { id: number; name: string };
  price: string;
  error?: string;
  // TODO: confirmar campos completos retornados por POST /me/shipment/calculate no payload real
  [key: string]: unknown;
}

export class MelhorEnvioApiError extends Error {
  status: number;
  body: MeApiErrorBody | undefined;
  constructor(message: string, status: number, body: MeApiErrorBody | undefined) {
    super(message);
    this.name = "MelhorEnvioApiError";
    this.status = status;
    this.body = body;
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

function isRetryable(error: unknown): boolean {
  if (error instanceof InsufficientBalanceError) return false;
  if (error instanceof MelhorEnvioApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

async function meFetch<T>(config: AppConfig, path: string, init: RequestInit = {}): Promise<T> {
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

export function buildFromAddress(config: AppConfig): MeAddress {
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

export async function calculateShipping(config: AppConfig, payload: MeCalculateRequest): Promise<MeCalculateQuote[]> {
  return withRetry(
    () => meFetch<MeCalculateQuote[]>(config, "/me/shipment/calculate", { method: "POST", body: JSON.stringify(payload) }),
    { label: "melhorenvio.calculateShipping", isRetryable },
  );
}

export async function addToCart(config: AppConfig, payload: MeCartRequest): Promise<MeCartItemResponse> {
  return withRetry(
    () => meFetch<MeCartItemResponse>(config, "/me/cart", { method: "POST", body: JSON.stringify(payload) }),
    { label: "melhorenvio.addToCart", isRetryable },
  );
}

export async function checkoutCart(config: AppConfig, cartItemIds: string[]): Promise<MeCheckoutResponse> {
  return withRetry(
    () =>
      meFetch<MeCheckoutResponse>(config, "/me/shipment/checkout", {
        method: "POST",
        body: JSON.stringify({ orders: cartItemIds }),
      }),
    { label: "melhorenvio.checkoutCart", isRetryable },
  );
}

export async function generateLabel(config: AppConfig, orderIds: string[]): Promise<MeGenerateLabelResponse> {
  return withRetry(
    () =>
      meFetch<MeGenerateLabelResponse>(config, "/me/shipment/generate", {
        method: "POST",
        body: JSON.stringify({ orders: orderIds }),
      }),
    { label: "melhorenvio.generateLabel", isRetryable },
  );
}

export async function printLabel(config: AppConfig, orderIds: string[]): Promise<MePrintLabelResponse> {
  return withRetry(
    () =>
      meFetch<MePrintLabelResponse>(config, "/me/shipment/print", {
        method: "POST",
        body: JSON.stringify({ orders: orderIds, mode: "public" }),
      }),
    { label: "melhorenvio.printLabel", isRetryable },
  );
}

// DACE (Documento Auxiliar de Conteudo Eletronico) is the content
// declaration required for non-commercial shipments (no NF-e) — a separate
// document from the shipping label itself. The URL is a short-lived (~30min)
// pre-signed S3 link, so unlike the label PDF it's never stored, only
// fetched live right before printing.
export async function fetchDeclarationPdfUrl(config: AppConfig, melhorEnvioOrderId: string): Promise<string> {
  return withRetry(
    async () => {
      const urls = await meFetch<string[]>(config, `/me/imprimir/dace/pdf/${melhorEnvioOrderId}`, { method: "GET" });
      const url = urls[0];
      if (!url) throw new Error("Melhor Envio returned no DACE URL");
      return url;
    },
    { label: "melhorenvio.fetchDeclarationPdfUrl", isRetryable },
  );
}

export async function cancelLabel(config: AppConfig, orderIds: string[], reason?: string): Promise<MeCancelResponse> {
  return withRetry(
    () =>
      meFetch<MeCancelResponse>(config, "/me/shipment/cancel", {
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

// Response is keyed by order id (confirmed against Melhor Envio's docs) —
// NOT a flat { tracking } object. `tracking` is only populated once the
// carrier has actually posted the shipment, so it's frequently absent right
// after label generation.
export interface MeTrackingEntry {
  id: string;
  status?: string;
  tracking?: string;
  melhorenvio_tracking?: string;
  // Set by Melhor Envio once the carrier scans the package in — this is the
  // source of truth for "posted", no manual confirmation needed.
  posted_at?: string | null;
}

// Batched: /me/shipment/tracking accepts multiple order ids per call and
// keys the response by id, so the reconciliation sync can check every
// not-yet-posted order in one request instead of one per order.
export async function fetchTrackingBatch(config: AppConfig, orderIds: string[]): Promise<Record<string, MeTrackingEntry>> {
  if (orderIds.length === 0) return {};
  return withRetry(
    () =>
      meFetch<Record<string, MeTrackingEntry>>(config, "/me/shipment/tracking", {
        method: "POST",
        body: JSON.stringify({ orders: orderIds }),
      }),
    { label: "melhorenvio.fetchTracking", isRetryable },
  );
}

export async function fetchTrackingByOrderId(config: AppConfig, orderId: string): Promise<string | undefined> {
  const response = await fetchTrackingBatch(config, [orderId]);
  return response[orderId]?.tracking;
}

// Calls /me/shipment/calculate with the same from/to/products/volumes and
// picks the lowest-priced quote (optionally restricted to an allow-list of
// service ids). Falls back to the fixed MELHORENVIO_SERVICE_ID if
// auto-cheapest is off, the calculation call fails, or no quote comes back
// valid (e.g. destination not covered) — the pipeline must never block on
// picking a carrier.
export async function pickCheapestServiceId(
  config: AppConfig,
  payload: Omit<MeCartRequest, "service">,
  shopifyOrderId: string,
): Promise<number> {
  if (!config.melhorEnvio.autoCheapest) {
    return config.melhorEnvio.serviceId;
  }

  try {
    const quotes = await calculateShipping(config, {
      from: payload.from,
      to: payload.to,
      products: payload.products,
      volumes: payload.volumes,
      options: { insurance_value: payload.options.insurance_value },
    });

    const allowed = config.melhorEnvio.allowedServiceIds;
    const valid = quotes.filter((quote) => {
      if (quote.error) return false;
      const price = Number(quote.price);
      if (!Number.isFinite(price) || price <= 0) return false;
      if (allowed.length > 0 && !allowed.includes(quote.id)) return false;
      return true;
    });

    if (valid.length === 0) {
      console.log(JSON.stringify({ level: "warn", shopifyOrderId, msg: "melhorenvio_no_valid_quote_falling_back_to_default_service" }));
      return config.melhorEnvio.serviceId;
    }

    const cheapest = valid.reduce((min, quote) => (Number(quote.price) < Number(min.price) ? quote : min));
    console.log(
      JSON.stringify({
        shopifyOrderId,
        serviceId: cheapest.id,
        serviceName: cheapest.name,
        price: cheapest.price,
        msg: "melhorenvio_cheapest_service_selected",
      }),
    );
    return cheapest.id;
  } catch (error) {
    console.log(
      JSON.stringify({ level: "warn", shopifyOrderId, err: String(error), msg: "melhorenvio_calculate_failed_falling_back_to_default_service" }),
    );
    return config.melhorEnvio.serviceId;
  }
}
