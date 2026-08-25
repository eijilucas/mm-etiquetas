import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleReconciliationCron } from "../supabase/functions/reconciliation-cron/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// No orders pending anywhere — keeps the run itself trivial so these tests
// only exercise the lock, not reconciliation logic (already covered
// elsewhere).
function withEmptyShopifyMock(fn: () => Promise<void>) {
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
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function cronRequest() {
  return new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret },
  });
}

Deno.test("claims the lock, runs, and releases it back to null when done", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: null });

  await withEmptyShopifyMock(async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(cronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.scanned, 0);
  });

  assertEquals(fake.table("cron_locks")[0].running_since, null);
});

Deno.test("skips the run entirely when another invocation claimed the lock seconds ago", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: new Date().toISOString() });

  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("should never call out — the cron is already claimed by another run");
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(cronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { skipped: true, reason: "already_running" });
  } finally {
    globalThis.fetch = original;
  }

  assertEquals(calls, 0);
});

Deno.test("reclaims a stale lock (older than 5 minutes) instead of skipping forever", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({
    name: "reconciliation",
    running_since: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // stale — a prior run crashed without releasing
  });

  await withEmptyShopifyMock(async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(cronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 200);
  });

  assertEquals(fake.table("cron_locks")[0].running_since, null); // claimed, ran, released
});

Deno.test("releases the lock even when reconciliation itself throws", async () => {
  const fake = makeFakeSupabase();
  fake.table("cron_locks").push({ name: "reconciliation", running_since: null });

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Shopify is down");
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(cronRequest(), { config, supabase: fake as any });
    assertEquals(res.status, 500);
  } finally {
    globalThis.fetch = original;
  }

  assertEquals(fake.table("cron_locks")[0].running_since, null); // not left stuck
});
