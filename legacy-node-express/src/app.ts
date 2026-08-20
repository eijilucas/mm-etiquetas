import express from "express";
import path from "node:path";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { requireInternalAuth } from "./lib/auth";
import { webhooksRouter } from "./routes/webhooks";
import { ordersRouter } from "./routes/orders";
import { runReconciliation } from "./reconciliation/cron";

export function buildApp() {
  const app = express();

  app.use(pinoHttp({ logger }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Raw body only for the webhook route (needed for HMAC verification).
  app.use("/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

  app.use(express.json());

  app.use("/api/orders", requireInternalAuth, ordersRouter);

  app.post("/api/reconciliation/run", requireInternalAuth, async (_req, res) => {
    const result = await runReconciliation();
    res.json(result);
  });

  // Static assets carry no order data by themselves; the panel JS prompts
  // for the bearer token and attaches it to every /api/* call, which is
  // where requireInternalAuth actually enforces access.
  app.use("/", express.static(path.join(__dirname, "..", "public")));

  return app;
}
