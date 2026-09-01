export interface StoreConfig {
  key: string;
  label: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  apiVersion: string;
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// One Shopify store per entry in SHOPIFY_STORE_KEYS (e.g. "basico,exclusivos").
// Every store's credentials live under a per-key env var prefix so a third
// store can be onboarded later by only adding secrets, no code changes.
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
      // Shopify's newer custom-app credentials only issue short-lived (~24h)
      // access tokens, so the app fetches a fresh one via the OAuth
      // client_credentials grant on every call instead of storing one
      // static, eventually-expiring token (see getAccessToken in shopify.ts).
      clientId: required(`SHOPIFY_${envKey}_CLIENT_ID`),
      clientSecret: required(`SHOPIFY_${envKey}_CLIENT_SECRET`),
      webhookSecret: required(`SHOPIFY_${envKey}_WEBHOOK_SECRET`),
      apiVersion: optional(`SHOPIFY_${envKey}_API_VERSION`, defaultApiVersion),
    };
  });
}

export function loadConfig() {
  return {
    cronSecret: required("CRON_SECRET"),

    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

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
      // Fallback service used when auto-cheapest is off, or when the
      // /calculate call fails or returns no valid quote (e.g. destination not
      // covered by any of the allowed carriers) — the pipeline must never
      // block on this.
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
      // Sent as the Shopify Fulfillment's tracking URL — must be a tracking
      // lookup page, not the label PDF, since Melhor Envio isn't a carrier
      // Shopify recognizes (so it can't auto-generate a tracking link).
      trackingUrl: optional("MELHORENVIO_TRACKING_URL", "https://melhorrastreio.com.br"),
      // Fixed declared value per product, same standardized-estimate logic
      // as the volume profile above — the store doesn't declare each
      // product's real sale price on the (non-commercial, no-NF-e) content
      // declaration, it uses this flat convention for every item instead.
      declaredValuePerItem: Number(optional("MELHORENVIO_DECLARED_VALUE_PER_ITEM", "250")),
      // Below this, the panel shows a low-balance warning banner — picked
      // so there's still room for a handful of label purchases before the
      // wallet actually runs out and starts hard-failing the pipeline.
      lowBalanceThreshold: Number(optional("MELHORENVIO_LOW_BALANCE_THRESHOLD", "100")),
      // The store doesn't track real per-product weight/dimensions in
      // Shopify (no read_products scope, no weight registered on any
      // variant) — Vitor's own manual process is a fixed estimate by item
      // count, so the pipeline reproduces that exact rule instead of relying
      // on Shopify's (always-zero, for this store) line_items[].grams.
      volumeProfile: {
        single: {
          heightCm: Number(optional("VOLUME_SINGLE_HEIGHT_CM", "2")),
          widthCm: Number(optional("VOLUME_SINGLE_WIDTH_CM", "20")),
          lengthCm: Number(optional("VOLUME_SINGLE_LENGTH_CM", "20")),
          weightKg: Number(optional("VOLUME_SINGLE_WEIGHT_KG", "0.5")),
        },
        multiple: {
          heightCm: Number(optional("VOLUME_MULTI_HEIGHT_CM", "2")),
          widthCm: Number(optional("VOLUME_MULTI_WIDTH_CM", "40")),
          lengthCm: Number(optional("VOLUME_MULTI_LENGTH_CM", "40")),
          weightKg: Number(optional("VOLUME_MULTI_WEIGHT_KG", "1")),
        },
      },
    },

    alerts: {
      webhookUrl: optional("ALERT_WEBHOOK_URL"),
      stuckHours: Number(optional("ALERT_STUCK_HOURS", "4")),
    },

    // Best-effort stock deduction on the sibling mental-madness-estoque
    // project — see reportLabelGenerated/reportLabelCancelled in
    // _shared/estoque.ts. Left unset (both optional) so the pipeline works
    // fine in environments that never configured it.
    estoque: {
      apiUrl: optional("ESTOQUE_API_URL"),
      integrationSecret: optional("ESTOQUE_INTEGRATION_SECRET"),
    },

    // Autentica external-order-intake (chamada pelo mental-madness-vendas-
    // externas quando cria um pedido) — secret dedicado, não reaproveita
    // nenhum outro já existente, pra poder rotacionar/revogar independente.
    externalOrders: {
      secret: optional("EXTERNAL_ORDERS_SECRET"),
    },

    // Callback assinado de saída pra mental-madness-vendas-externas
    // (integration-callback) — avisa quando o rastreio de um pedido
    // externo é liberado, pra ela mandar o e-mail pro cliente. Secret
    // dedicado (INTEGRATION_CALLBACK_SECRET), diferente de
    // EXTERNAL_ORDERS_SECRET (aquele autentica a entrada do pedido; este
    // autentica a saída do status). Ambos opcionais: sem eles configurados,
    // o callback é pulado (log + no-op), não quebra o pipeline de etiqueta.
    integrationCallback: {
      url: optional("VENDAS_EXTERNAS_FUNCTIONS_URL"),
      secret: optional("INTEGRATION_CALLBACK_SECRET"),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function getStoreByKey(config: AppConfig, key: string): StoreConfig | undefined {
  return config.shopify.stores.find((store) => store.key === key.toLowerCase());
}
