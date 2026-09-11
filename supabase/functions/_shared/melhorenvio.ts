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

// Melhor Envio occasionally answers a 2xx with a truly empty body (no
// endpoint here legitimately succeeds with nothing back — even "no results"
// responses come back as "[]"/"{}", which parse fine and never hit this).
// Was previously swallowed silently: meFetch just returned undefined, and
// every caller had to notice that on its own — checkoutCart's caller threw
// its own ad-hoc error for it, while pickCheapestServiceId's caller didn't
// notice at all and silently fell back to the fixed default service (the
// root cause of "preço mais barato não está funcionando"). Does NOT extend
// MelhorEnvioApiError on purpose, so isRetryable's default `return true`
// picks it up automatically — every meFetch caller already wrapped in
// withRetry now retries this the same as a 429/5xx instead of needing its
// own special case.
export class MelhorEnvioEmptyResponseError extends Error {
  constructor(path: string) {
    super(`Melhor Envio respondeu 2xx com corpo vazio para ${path}`);
    this.name = "MelhorEnvioEmptyResponseError";
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

// Melhor Envio doesn't document a request-rate limit anywhere, so the
// stagger added to the bulk-approve/retry loops (see orders-api/index.ts,
// reconciliation.ts) is a conservative guess, not a proven-safe number.
// Logs whatever rate-limit-shaped headers they actually send back (if any)
// on every call, success or error, so real data — not another guess — can
// tell us the real limit and let the stagger be tuned to it. Silent no-op
// (nothing logged) if Melhor Envio sends none of these on a given response.
function logRateLimitHeaders(path: string, response: Response): void {
  const found: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    if (/rate.?limit|retry-after/i.test(key)) {
      found[key] = value;
    }
  }
  if (Object.keys(found).length > 0) {
    console.log(JSON.stringify({ path, status: response.status, headers: found, msg: "melhorenvio_rate_limit_headers" }));
  }
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

  logRateLimitHeaders(path, response);

  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    if (isInsufficientBalanceBody(body)) {
      throw new InsufficientBalanceError(response.status, body);
    }
    throw new MelhorEnvioApiError(`Melhor Envio API error ${response.status}: ${describeErrorBody(body)}`, response.status, body);
  }

  // No endpoint below legitimately succeeds with a truly empty body — a
  // "no results" response still comes back as "[]"/"{}", which parses to a
  // real (non-undefined) value and never trips this. body is only undefined
  // when the response had zero bytes, which is Melhor Envio's API glitching
  // under load, not a valid outcome — see MelhorEnvioEmptyResponseError.
  if (body === undefined) {
    throw new MelhorEnvioEmptyResponseError(path);
  }
  return body as T;
}

// The API body's actual reason (e.g. "CEP inválido", a per-field validation
// message) used to be captured on the error but never surfaced into the
// message string — so last_error only ever showed the useless "error 422"
// part, not what Melhor Envio actually said was wrong.
function describeErrorBody(body: MeApiErrorBody | undefined): string {
  if (!body) return "sem detalhes na resposta";
  const parts: string[] = [];
  if (body.message) parts.push(body.message);
  if (body.errors) {
    for (const [field, messages] of Object.entries(body.errors)) {
      parts.push(`${field}: ${Array.isArray(messages) ? messages.join(", ") : String(messages)}`);
    }
  }
  if (parts.length > 0) return parts.join(" | ");

  // Neither field above had anything, but the body itself wasn't empty --
  // dump it raw instead of just "sem detalhes na resposta", in case Melhor
  // Envio used a different shape this time (a differently-named field, a
  // top-level string) that would otherwise be silently lost. This is
  // exactly what's needed to diagnose a failure whose real body we can't
  // see any other way (last_error is the only record of it — the response
  // itself is gone once handled).
  try {
    const raw = JSON.stringify(body);
    return raw && raw !== "{}" ? `sem detalhes na resposta (corpo bruto: ${raw})` : "sem detalhes na resposta";
  } catch {
    return "sem detalhes na resposta";
  }
}

export interface MeBalanceResponse {
  balance?: number | string | { available?: number | string; value?: number | string };
  [key: string]: unknown;
}

// GET /me/balance isn't in Melhor Envio's public docs (only found via
// unofficial SDKs) and returned 403 against this app's current access token
// when tested directly — the token's scopes don't include wallet/balance
// read access, so it needs to be regenerated on Melhor Envio's site with
// that permission before this ever returns a real number. Until then (and
// for any other unexpected failure) this returns null instead of throwing,
// so the panel just hides the balance banner rather than breaking.
export async function fetchAccountBalance(config: AppConfig): Promise<number | null> {
  try {
    const body = await meFetch<MeBalanceResponse>(config, "/me/balance", { method: "GET" });
    const raw =
      typeof body?.balance === "object" && body.balance !== null
        ? body.balance.available ?? body.balance.value
        : body?.balance;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    console.log(JSON.stringify({ level: "warn", err: String(error), msg: "melhorenvio_balance_fetch_failed" }));
    return null;
  }
}

// Undocumented shape, confirmed against a real response 2026-09-10 (see
// git history for the probe that pulled it): GET /me/orders/search?q=
// returns a page of orders whose `conciliation` sub-object carries the
// post-postagem reweigh/dimension adjustment ("débito de conferência" in
// ME's own panel, under Financeiro > Diferenças) — `value` (BRL) and
// `type` ("debit": ME charges more; presumably "credit" for the reverse,
// unconfirmed live). `q` is a fuzzy search (tracking/protocol/id/document),
// so results are filtered down to an exact `tracking` match before use.
interface MeConciliationOrderItem {
  tracking?: string;
  conciliation?: {
    value?: number;
    type?: string;
  } | null;
}

interface MeOrderSearchResponse {
  data?: MeConciliationOrderItem[];
}

// Net conference-debit difference (BRL) for one shipment, or null if there's
// no order matching this tracking code at all. Debits add, credits subtract
// (so a corrected-down reweigh nets negative) — callers decide what to do
// with a zero/negative/null result. Best-effort at the call-site: this
// throws on a real API/network failure same as every other melhorenvio.ts
// function, so a caller looping over many tracking codes needs its own
// try/catch per iteration to not let one lookup abort the batch.
export async function fetchConciliationDifference(config: AppConfig, trackingCode: string): Promise<number | null> {
  const body = await meFetch<MeOrderSearchResponse>(config, `/me/orders/search?q=${encodeURIComponent(trackingCode)}`, {
    method: "GET",
  });
  const matches = (body?.data ?? []).filter((order) => order.tracking === trackingCode);
  if (matches.length === 0) return null;

  let net = 0;
  let sawConciliation = false;
  for (const order of matches) {
    const value = order.conciliation?.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value === 0) continue;
    sawConciliation = true;
    net += order.conciliation?.type === "credit" ? -value : value;
  }
  return sawConciliation ? net : null;
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
  // ME's own order protocol ("ORD-<sequential number>") — assigned when the
  // shipment is created on Melhor Envio, so it increases in the same order
  // ME's own "Pedidos" list is sorted (created_at desc == protocol desc).
  protocol?: string;
  tracking?: string;
  melhorenvio_tracking?: string;
  // When the shipment was created on Melhor Envio (cart -> purchase). This is
  // the field ME's panel list is ordered by (descending).
  created_at?: string;
  // When the label PDF was generated. Used as a "posted around here" proxy
  // for shipments ME advanced past "released" without ever stamping
  // posted_at (see syncPostedOrders).
  generated_at?: string;
  // Set by Melhor Envio when the carrier scans the package in — but ME does
  // NOT populate it reliably: confirmed live that orders sitting at status
  // "received" (already collected by the carrier, shown as postado in ME's
  // own panel) still have posted_at = null. So it can't be the only signal
  // for "posted" — see POSTED_ME_STATUSES in reconciliation.ts.
  posted_at?: string | null;
}

// ME order lifecycle past "released" (etiqueta gerada): the shipment has
// left our hands. "posted" is the clean case; "received"/"delivered" mean it
// was posted and moved on — and ME frequently skips straight to those
// without a posted_at, so status has to be trusted too.
export const POSTED_ME_STATUSES = new Set(["posted", "received", "delivered"]);

const TRACKING_BATCH_SIZE = 100;

// Batched: /me/shipment/tracking accepts multiple order ids per call and
// keys the response by id, so the reconciliation sync can check every
// not-yet-posted order in a handful of requests instead of one per order.
//
// The catch: ME 422s the WHOLE request if a single id in the list is
// malformed — confirmed live, "O campo orders.N deve ter pelo menos 36
// caracteres" (real ids are 36-char UUIDs). One bad melhor_envio_order_id
// in our table (an empty string, a truncated value) used to blow up the
// entire posted-status sync so nothing ever moved to Postados. Now empty
// ids are dropped up front and any chunk that still fails is binary-split
// to isolate and skip just the offending id(s), keeping the rest.
export async function fetchTrackingBatch(config: AppConfig, orderIds: string[]): Promise<Record<string, MeTrackingEntry>> {
  const ids = [...new Set(orderIds.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
  if (ids.length === 0) return {};
  const result: Record<string, MeTrackingEntry> = {};
  for (let i = 0; i < ids.length; i += TRACKING_BATCH_SIZE) {
    await fetchTrackingChunk(config, ids.slice(i, i + TRACKING_BATCH_SIZE), result);
  }
  return result;
}

async function fetchTrackingChunk(
  config: AppConfig,
  chunk: string[],
  result: Record<string, MeTrackingEntry>,
): Promise<void> {
  if (chunk.length === 0) return;
  try {
    const part = await withRetry(
      () =>
        meFetch<Record<string, MeTrackingEntry>>(config, "/me/shipment/tracking", {
          method: "POST",
          body: JSON.stringify({ orders: chunk }),
        }),
      { label: "melhorenvio.fetchTracking", isRetryable },
    );
    Object.assign(result, part);
  } catch (error) {
    if (chunk.length === 1) {
      console.log(JSON.stringify({ orderId: chunk[0], err: String(error), level: "warn", msg: "melhorenvio_tracking_id_skipped" }));
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    await fetchTrackingChunk(config, chunk.slice(0, mid), result);
    await fetchTrackingChunk(config, chunk.slice(mid), result);
  }
}

// `tracking` (the raw carrier-native code) really can stay null for a long
// time for some carriers — confirmed live on a Jadlog shipment sitting at
// status "released" (not yet posted) where `tracking` was null but
// `melhorenvio_tracking` already held a real, immediately-trackable code
// ("ME262CMAHI0BR", generated right after label creation, resolvable at
// melhorrastreio.com.br). Only reading `tracking` meant those orders threw
// TRACKING_NOT_YET_AVAILABLE_ERROR and got auto-retried every 15min forever
// — falling back to melhorenvio_tracking fixes that entire failure class.
export async function fetchTrackingByOrderId(config: AppConfig, orderId: string): Promise<string | undefined> {
  const response = await fetchTrackingBatch(config, [orderId]);
  const entry = response[orderId];
  return entry?.tracking || entry?.melhorenvio_tracking || undefined;
}

// Service ids that quote fine via /me/shipment/calculate but are rejected by
// POST /me/cart because they require an `options.agency_id` we never send
// (this integration has no agency/pickup-point configured for any carrier).
// Confirmed via GET /me/shipment/services: id 35 ("Standard" / Total Express)
// has requirements.rules["options.agency_id"] = ["required"], whose failure
// message is exactly "A agência é obrigatória ao selecionar este serviço" —
// the error real orders (e.g. #3374) hit when auto-cheapest picked it.
const SERVICES_REQUIRING_AGENCY = [35];

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
      if (SERVICES_REQUIRING_AGENCY.includes(quote.id)) return false;
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
