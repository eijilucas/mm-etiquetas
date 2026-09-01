import type { AppConfig } from "./config.ts";
import { signHmacHex } from "./hmac.ts";
import { withRetry } from "./retry.ts";

function log(fields: Record<string, unknown>, msg: string) {
  console.log(JSON.stringify({ msg, ...fields }));
}

interface ShippingCallbackEvent {
  sourceOrderId: string;
  event: string;
  status: string;
  metadata?: Record<string, unknown>;
}

// Dispara o callback assinado (contrato 04-shipping-callback.md) pro
// mental-madness-vendas-externas. Best-effort com retry (diferente do
// callback fire-and-forget que já existe pra mental-madness-estoque em
// _shared/estoque.ts) — falha permanente aqui não deve travar o pipeline
// de etiqueta em si, só fica sem avisar o cliente por e-mail (alguém
// percebe pela ausência do aviso, ou reprocessa manualmente depois).
export async function sendShippingCallback(config: AppConfig, event: ShippingCallbackEvent): Promise<void> {
  const { url, secret } = config.integrationCallback;
  if (!url || !secret) {
    log({ sourceOrderId: event.sourceOrderId, event: event.event }, "integration_callback_not_configured_skipping");
    return;
  }

  const payload = {
    eventId: crypto.randomUUID(),
    sourceOrderId: event.sourceOrderId,
    event: event.event,
    status: event.status,
    occurredAt: new Date().toISOString(),
    metadata: event.metadata ?? {},
  };
  const rawBody = JSON.stringify(payload);
  const signature = await signHmacHex(rawBody, secret);

  try {
    await withRetry(
      async () => {
        const res = await fetch(`${url}/functions/v1/integration-callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": signature,
          },
          body: rawBody,
        });
        if (!res.ok) {
          throw new Error(`integration-callback respondeu ${res.status}: ${await res.text()}`);
        }
      },
      { label: "integration_callback", attempts: 3 },
    );
    log({ sourceOrderId: event.sourceOrderId, event: event.event }, "integration_callback_succeeded");
  } catch (err) {
    log({ sourceOrderId: event.sourceOrderId, event: event.event, err: String(err) }, "integration_callback_failed_permanently");
  }
}
