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
