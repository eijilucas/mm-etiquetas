import { config } from "../config";
import { buildFromAddress, calculateShipping } from "../melhorenvio/client";
import { logger } from "../lib/logger";
import type { MeCartRequest } from "../melhorenvio/types";
import type { OrderShipping } from "@prisma/client";
import type { OrderItemSnapshot } from "../shopify/mapOrder";

export class MissingWeightError extends Error {
  constructor(shopifyOrderId: string) {
    super(`Order ${shopifyOrderId} has line items without weight (grams) registered on Shopify`);
    this.name = "MissingWeightError";
  }
}

function toAddress(raw: Record<string, unknown>) {
  const address = raw as {
    name?: string;
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string | null;
    city?: string;
    province_code?: string | null;
    zip?: string;
    country_code?: string;
    phone?: string | null;
  };
  const name = address.name ?? [address.first_name, address.last_name].filter(Boolean).join(" ");
  return {
    name: name || "Cliente",
    phone: address.phone ?? undefined,
    postal_code: (address.zip ?? "").replace(/\D/g, ""),
    address: address.address1 ?? "",
    number: "S/N",
    complement: address.address2 ?? undefined,
    district: "",
    city: address.city ?? "",
    state_abbr: address.province_code ?? "",
  };
}

// Calls /me/shipment/calculate with the same from/to/products/volumes and
// picks the lowest-priced quote (optionally restricted to an allow-list of
// service ids). Falls back to the fixed MELHORENVIO_SERVICE_ID if
// auto-cheapest is off, the calculation call fails, or no quote comes back
// valid (e.g. destination not covered) — the pipeline must never block on
// picking a carrier.
async function pickCheapestServiceId(payload: Omit<MeCartRequest, "service">, shopifyOrderId: string): Promise<number> {
  if (!config.melhorEnvio.autoCheapest) {
    return config.melhorEnvio.serviceId;
  }

  try {
    const quotes = await calculateShipping({
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
      logger.warn({ shopifyOrderId }, "melhorenvio_no_valid_quote_falling_back_to_default_service");
      return config.melhorEnvio.serviceId;
    }

    const cheapest = valid.reduce((min, quote) => (Number(quote.price) < Number(min.price) ? quote : min));
    logger.info(
      { shopifyOrderId, serviceId: cheapest.id, serviceName: cheapest.name, price: cheapest.price },
      "melhorenvio_cheapest_service_selected",
    );
    return cheapest.id;
  } catch (error) {
    logger.warn({ shopifyOrderId, err: error }, "melhorenvio_calculate_failed_falling_back_to_default_service");
    return config.melhorEnvio.serviceId;
  }
}

export async function buildCartPayload(order: OrderShipping): Promise<MeCartRequest> {
  const items = order.items as unknown as OrderItemSnapshot[];
  const totalGrams = items.reduce((sum, item) => sum + item.grams * item.quantity, 0);
  if (totalGrams <= 0) {
    throw new MissingWeightError(order.shopifyOrderId);
  }

  const insuranceValue = Number(order.totalPrice);

  const base: Omit<MeCartRequest, "service"> = {
    from: buildFromAddress(),
    to: toAddress(order.shippingAddress as unknown as Record<string, unknown>),
    products: items.map((item) => ({
      name: item.title,
      quantity: item.quantity,
      unitary_value: Number(item.unitPrice),
    })),
    volumes: [
      {
        height: config.melhorEnvio.defaultVolume.heightCm,
        width: config.melhorEnvio.defaultVolume.widthCm,
        length: config.melhorEnvio.defaultVolume.lengthCm,
        weight: totalGrams / 1000,
      },
    ],
    options: {
      insurance_value: insuranceValue,
      // Declaracao de conteudo automatica do Melhor Envio a partir de
      // products[].unitary_value substitui a NF-e para fins da etiqueta;
      // por isso nunca enviamos `invoice` aqui.
      non_commercial: true,
      platform: config.melhorEnvio.platformName,
    },
  };

  const service = await pickCheapestServiceId(base, order.shopifyOrderId);
  return { service, ...base };
}
