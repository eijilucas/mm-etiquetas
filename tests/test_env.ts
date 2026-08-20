function setDefault(name: string, value: string) {
  if (!Deno.env.get(name)) Deno.env.set(name, value);
}

setDefault("CRON_SECRET", "test-cron-secret");
setDefault("SUPABASE_URL", "http://localhost:54321");
setDefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
setDefault("SHOPIFY_STORE_KEYS", "test");
setDefault("SHOPIFY_TEST_SHOP_DOMAIN", "test-shop.myshopify.com");
setDefault("SHOPIFY_TEST_CLIENT_ID", "test-client-id");
setDefault("SHOPIFY_TEST_CLIENT_SECRET", "test-client-secret");
setDefault("SHOPIFY_TEST_WEBHOOK_SECRET", "test-webhook-secret");
setDefault("MELHORENVIO_ACCESS_TOKEN", "test-me-token");
setDefault("MELHORENVIO_FROM_NAME", "Test Sender");
setDefault("MELHORENVIO_FROM_PHONE", "11999999999");
setDefault("MELHORENVIO_FROM_EMAIL", "sender@test.com");
setDefault("MELHORENVIO_FROM_DOCUMENT", "00000000000");
setDefault("MELHORENVIO_FROM_POSTAL_CODE", "01310930");
setDefault("MELHORENVIO_FROM_ADDRESS", "Av. Paulista");
setDefault("MELHORENVIO_FROM_NUMBER", "1000");
setDefault("MELHORENVIO_FROM_DISTRICT", "Bela Vista");
setDefault("MELHORENVIO_FROM_CITY", "Sao Paulo");
setDefault("MELHORENVIO_FROM_STATE_ABBR", "SP");
