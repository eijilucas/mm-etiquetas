import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleReconciliationCron } from "../supabase/functions/reconciliation-cron/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function conciliationCronRequest() {
  return new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ job: "melhorenvio_conciliation" }),
  });
}

Deno.test("job=melhorenvio_conciliation runs the conciliation sync, not the default reconciliation steps", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: null });
  fake.table("cron_locks").push({ name: "melhorenvio_conciliation", running_since: null });
  // No candidates -> no Shopify/Melhor Envio calls at all. Any fetch call
  // here would mean the wrong job ran (e.g. runReconciliation hitting Shopify).
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected fetch call: ${typeof input === "string" ? input : input.toString()}`);
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(conciliationCronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { checked: 0, found: 0, reported: 0 });
  } finally {
    globalThis.fetch = original;
  }

  // Its own lock claimed and released; the reconciliation lock untouched.
  assertEquals(fake.table("cron_locks").find((r) => r.name === "melhorenvio_conciliation")?.running_since, null);
  assertEquals(fake.table("cron_locks").find((r) => r.name === "reconciliation")?.running_since, null);
});

Deno.test("job=melhorenvio_conciliation skips when its own lock is already claimed, independent of the reconciliation lock", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: null });
  fake.table("cron_locks").push({ name: "melhorenvio_conciliation", running_since: new Date().toISOString() });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected fetch call: ${typeof input === "string" ? input : input.toString()}`);
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(conciliationCronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { skipped: true, reason: "already_running" });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("an empty body (the existing every-1-minute job) still runs the default reconciliation path", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: null });
  fake.table("cron_locks").push({ name: "melhorenvio_conciliation", running_since: null });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) {
      return jsonResponse({ access_token: "shpat_test-fetched", scope: "read_orders", expires_in: 86399 });
    }
    if (url.includes("/orders.json")) {
      return jsonResponse({ orders: [] });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }) as typeof fetch;

  const defaultCronRequest = new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret },
  });

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(defaultCronRequest, { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.scanned, 0); // shape only runReconciliation returns -> proves the default path ran
  } finally {
    globalThis.fetch = original;
  }

  // Its own lock claimed and released; the conciliation lock untouched.
  assertEquals(fake.table("cron_locks").find((r) => r.name === "reconciliation")?.running_since, null);
  assertEquals(fake.table("cron_locks").find((r) => r.name === "melhorenvio_conciliation")?.running_since, null);
});
