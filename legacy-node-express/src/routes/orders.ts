import { Router } from "express";
import { prisma } from "../db/prisma";
import { enqueueShippingJob } from "../queue/queue";
import { logger } from "../lib/logger";
import type { ShippingStatus } from "@prisma/client";

export const ordersRouter = Router();

const PROCESSING_STATUSES: ShippingStatus[] = [
  "approved",
  "cart_created",
  "purchased",
  "label_generated",
  "tracking_synced",
  "failed",
];

ordersRouter.get("/pending", async (_req, res) => {
  const orders = await prisma.orderShipping.findMany({
    where: { status: "pending_approval" },
    orderBy: { paidAt: "asc" },
  });
  res.json({ orders });
});

ordersRouter.get("/processing", async (_req, res) => {
  const orders = await prisma.orderShipping.findMany({
    where: { status: { in: PROCESSING_STATUSES } },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ orders });
});

ordersRouter.get("/held", async (_req, res) => {
  const orders = await prisma.orderShipping.findMany({
    where: { status: "held" },
    orderBy: { heldAt: "desc" },
  });
  res.json({ orders });
});

ordersRouter.get("/:id", async (req, res) => {
  const order = await prisma.orderShipping.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json({ order });
});

// Manual approval is the ONLY trigger that enqueues the shipping pipeline.
ordersRouter.post("/approve", async (req, res) => {
  const { ids, approvedBy } = req.body as { ids: string[]; approvedBy?: string };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids_required" });
  }

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      const order = await prisma.orderShipping.findUniqueOrThrow({ where: { id } });
      if (order.status !== "pending_approval") {
        results.push({ id, ok: false, error: `order status is ${order.status}, not pending_approval` });
        continue;
      }
      await prisma.orderShipping.update({
        where: { id },
        data: { status: "approved", approvedBy: approvedBy ?? "panel", approvedAt: new Date() },
      });
      await enqueueShippingJob(id);
      results.push({ id, ok: true });
    } catch (error) {
      logger.error({ err: error, id }, "approve_failed");
      results.push({ id, ok: false, error: "internal_error" });
    }
  }
  res.json({ results });
});

ordersRouter.post("/hold", async (req, res) => {
  const { ids, reason, heldBy } = req.body as { ids: string[]; reason: string; heldBy?: string };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids_required" });
  }
  if (!reason) {
    return res.status(400).json({ error: "reason_required" });
  }

  await prisma.orderShipping.updateMany({
    where: { id: { in: ids } },
    data: { status: "held", heldReason: reason, heldBy: heldBy ?? "panel", heldAt: new Date() },
  });
  res.json({ ok: true });
});

// Explicit manual reversal is the only way a held order re-enters pending_approval.
ordersRouter.post("/revert", async (req, res) => {
  const { ids } = req.body as { ids: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids_required" });
  }
  await prisma.orderShipping.updateMany({
    where: { id: { in: ids }, status: "held" },
    data: { status: "pending_approval", heldReason: null, heldBy: null, heldAt: null },
  });
  res.json({ ok: true });
});

// Reprocess a failed (or partially processed) order without duplicating
// already-completed external steps — the pipeline itself is idempotent per status.
ordersRouter.post("/:id/reprocess", async (req, res) => {
  const order = await prisma.orderShipping.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "pending_approval" || order.status === "held") {
    return res.status(400).json({ error: `cannot reprocess order in status ${order.status}` });
  }
  await prisma.orderShipping.update({ where: { id: order.id }, data: { lastError: null } });
  await enqueueShippingJob(order.id);
  res.json({ ok: true });
});
