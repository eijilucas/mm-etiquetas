import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Gates the panel + /api/* routes. Internal ops tool, so a single shared
// bearer token is enough — no per-user accounts required by the spec.
export function requireInternalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token && safeEqual(token, config.internalApiToken)) {
    return next();
  }
  res.status(401).json({ error: "unauthorized" });
}
