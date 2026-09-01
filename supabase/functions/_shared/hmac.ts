// HMAC-SHA256 em hex — contrato definido em
// docs/api-contracts/04-shipping-callback.md (X-Signature: <hex>) no repo
// mental-madness-vendas-externas. Espelha
// mental-madness-vendas-externas/supabase/functions/_shared/hmac.ts (lado
// que verifica); aqui só precisamos assinar (lado que envia).

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signHmacHex(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return toHex(new Uint8Array(signature));
}
