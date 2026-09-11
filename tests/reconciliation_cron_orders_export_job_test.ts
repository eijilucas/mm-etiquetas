import "./test_env.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { handleReconciliationCron } from "../supabase/functions/reconciliation-cron/index.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { makeFakeSupabase } from "./fake_supabase.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function exportCronRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/functions/v1/reconciliation-cron", {
    method: "POST",
    headers: { "x-cron-secret": config.cronSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ job: "melhorenvio_orders_export", ...body }),
  });
}

Deno.test("passes status and page through to GET /me/orders and returns the raw response", async () => {
  const fake = makeFakeSupabase();
  let calledUrl = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calledUrl = typeof input === "string" ? input : input.toString();
    return jsonResponse({ data: [{ id: "a" }, { id: "b" }], current_page: 2 });
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(exportCronRequest({ status: "posted", page: 2 }), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { raw: { data: [{ id: "a" }, { id: "b" }], current_page: 2 } });
    assertEquals(calledUrl.includes("status=posted"), true);
    assertEquals(calledUrl.includes("page=2"), true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("defaults to page 1 and no status filter when neither is given", async () => {
  const fake = makeFakeSupabase();
  let calledUrl = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calledUrl = typeof input === "string" ? input : input.toString();
    return jsonResponse({ data: [] });
  }) as typeof fetch;

  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleReconciliationCron(exportCronRequest({}), { config, supabase: fake as any });
    assertEquals(res.status, 200);
    assertEquals(calledUrl.includes("status="), false);
    assertEquals(calledUrl.includes("page=1"), true);
  } finally {
    globalThis.fetch = original;
  }
});
