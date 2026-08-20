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

// orders-api has `verify_jwt = true` in config.toml, so Supabase's gateway
// already validated the JWT's signature/expiry before this code ever runs —
// we only need to decode the payload (no re-verification needed) and check
// it's a real logged-in user ("authenticated" role), not just a request
// carrying the public anon key (which is also a technically-valid JWT).
export function getAuthenticatedUser(req: Request): AuthenticatedUser | null {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.role !== "authenticated" || typeof payload.email !== "string") return null;
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export function requireCronSecret(req: Request, config: AppConfig): boolean {
  const header = req.headers.get("x-cron-secret") ?? "";
  return !!header && safeEqual(header, config.cronSecret);
}
