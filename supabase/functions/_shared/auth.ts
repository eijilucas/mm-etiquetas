import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AppConfig } from "./config.ts";

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export interface AuthenticatedUser {
  id: string;
  email: string;
}

// orders-api used to have `verify_jwt = true` in config.toml and just decode
// the (gateway-pre-verified) payload here. That broke on 2026-09-10: this
// project rotated to asymmetric JWT Signing Keys (ECC/P-256), and the
// gateway's built-in verify_jwt only understands the legacy symmetric
// (HS256) secret -- every freshly issued/refreshed session token got
// rejected at the gateway with 401 UNAUTHORIZED_ASYMMETRIC_JWT before this
// code ever ran. Fix (per Supabase's own guidance for asymmetric-key
// projects): verify_jwt is now `false`, and this calls the Auth API's
// getUser(token) instead -- it validates the token's signature/expiry
// (regardless of which key type signed it) and, unlike local decoding, also
// catches a token whose session was revoked. `supabase` is the existing
// service-role client already created per-request in orders-api; getUser
// works against any token when called from a service-role client.
export async function getAuthenticatedUser(
  req: Request,
  supabase: SupabaseClient,
): Promise<AuthenticatedUser | null> {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user || typeof data.user.email !== "string") return null;
  return { id: data.user.id, email: data.user.email };
}

export function requireCronSecret(req: Request, config: AppConfig): boolean {
  const header = req.headers.get("x-cron-secret") ?? "";
  return !!header && safeEqual(header, config.cronSecret);
}
