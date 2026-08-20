import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export interface StoreConfig {
  key: string;
  label: string;
  shopDomain: string;
  adminApiToken: string;
  webhookSecret: string;
  apiVersion: string;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// One Shopify store per entry in SHOPIFY_STORE_KEYS (e.g. "basico,exclusivos").
// Every store's credentials live under a per-key env var prefix so a third
// store can be onboarded later by only adding env vars, no code changes.
function loadStores(): StoreConfig[] {
  const keys = required("SHOPIFY_STORE_KEYS")
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);

  const defaultApiVersion = optional("SHOPIFY_API_VERSION", "2024-07");

  return keys.map((key) => {
    const envKey = key.toUpperCase();
    return {
      key,
      label: optional(`SHOPIFY_${envKey}_LABEL`, titleCase(key)),
      shopDomain: required(`SHOPIFY_${envKey}_SHOP_DOMAIN`),
      adminApiToken: required(`SHOPIFY_${envKey}_ADMIN_API_TOKEN`),
      webhookSecret: required(`SHOPIFY_${envKey}_WEBHOOK_SECRET`),
      apiVersion: optional(`SHOPIFY_${envKey}_API_VERSION`, defaultApiVersion),
    };
  });
}

export const config = {
  port: Number(optional("PORT", "3000")),
  nodeEnv: optional("NODE_ENV", "development"),
  internalApiToken: required("INTERNAL_API_TOKEN"),

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  shopify: {
    stores: loadStores(),
  },

  melhorEnvio: {
    baseUrl: optional("MELHORENVIO_BASE_URL", "https://sandbox.melhorenvio.com.br/api/v2"),
    accessToken: required("MELHORENVIO_ACCESS_TOKEN"),
    refreshToken: optional("MELHORENVIO_REFRESH_TOKEN"),
    clientId: optional("MELHORENVIO_CLIENT_ID"),
    clientSecret: optional("MELHORENVIO_CLIENT_SECRET"),
    userAgent: optional("MELHORENVIO_USER_AGENT", "MM Etiquetas (contato@example.com)"),
    from: {
      name: optional("MELHORENVIO_FROM_NAME"),
      phone: optional("MELHORENVIO_FROM_PHONE"),
      email: optional("MELHORENVIO_FROM_EMAIL"),
      document: optional("MELHORENVIO_FROM_DOCUMENT"),
      postalCode: optional("MELHORENVIO_FROM_POSTAL_CODE"),
      address: optional("MELHORENVIO_FROM_ADDRESS"),
      number: optional("MELHORENVIO_FROM_NUMBER"),
      complement: optional("MELHORENVIO_FROM_COMPLEMENT"),
      district: optional("MELHORENVIO_FROM_DISTRICT"),
      city: optional("MELHORENVIO_FROM_CITY"),
      stateAbbr: optional("MELHORENVIO_FROM_STATE_ABBR"),
    },
    // Fallback service used when auto-cheapest is off, or when the /calculate
    // call fails or returns no valid quote (e.g. destination not covered by
    // any of the allowed carriers) — the pipeline must never block on this.
    serviceId: Number(optional("MELHORENVIO_SERVICE_ID", "1")),
    // Vitor: frete sempre pela opcao mais barata disponivel (default true).
    autoCheapest: optional("MELHORENVIO_AUTO_CHEAPEST", "true") === "true",
    // Optional allow-list of service ids to consider when picking the
    // cheapest quote (comma-separated, e.g. "1,2,3" for Correios PAC/SEDEX +
    // Jadlog .Package). Empty = consider every service Melhor Envio quotes.
    allowedServiceIds: optional("MELHORENVIO_ALLOWED_SERVICE_IDS", "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id) && id > 0),
    platformName: optional("MELHORENVIO_PLATFORM_NAME", "MM Etiquetas"),
    // Shopify orders don't carry package dimensions, only line-item weight (grams).
    // TODO: substituir por dimensoes reais por produto (ex: metafield na Shopify) quando disponivel.
    defaultVolume: {
      heightCm: Number(optional("DEFAULT_VOLUME_HEIGHT_CM", "10")),
      widthCm: Number(optional("DEFAULT_VOLUME_WIDTH_CM", "15")),
      lengthCm: Number(optional("DEFAULT_VOLUME_LENGTH_CM", "20")),
    },
  },

  reconciliation: {
    cron: optional("RECONCILIATION_CRON", "*/15 * * * *"),
  },

  alerts: {
    webhookUrl: optional("ALERT_WEBHOOK_URL"),
    stuckHours: Number(optional("ALERT_STUCK_HOURS", "4")),
  },

  logLevel: optional("LOG_LEVEL", "info"),
};

export function getStoreByKey(key: string): StoreConfig | undefined {
  return config.shopify.stores.find((store) => store.key === key.toLowerCase());
}

export type AppConfig = typeof config;
