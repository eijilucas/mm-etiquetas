import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { requireCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/db.ts";
import { runReconciliation, checkStuckOrders, syncPostedOrders, retryStalledTracking } from "../_shared/reconciliation.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface Deps {
  config?: AppConfig;
  supabase?: SupabaseClient;
}

// Invoked by pg_cron (see supabase/migrations/0002_pg_cron.sql) every 15
// minutes. Gated by CRON_SECRET so it can't be triggered by a random public
// POST. Folds the "stuck order" alert check into the same run instead of a
// second scheduled job.
export async function handleReconciliationCron(req: Request, deps: Deps = {}): Promise<Response> {
  const config = deps.config ?? loadConfig();

  if (!requireCronSecret(req, config)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = deps.supabase ?? createServiceClient(config);

  try {
    const result = await runReconciliation(supabase, config);
    await checkStuckOrders(supabase, config);
    await syncPostedOrders(supabase, config);
    await retryStalledTracking(supabase, config);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.log(JSON.stringify({ level: "error", err: String(error), msg: "reconciliation_cron_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleReconciliationCron(req));
}
