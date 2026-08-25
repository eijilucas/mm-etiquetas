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

// Long enough that a legitimately slow run (scanning 100+ orders, one
// GraphQL call each) is never mistaken for stale, short enough that a run
// that crashed without releasing the lock self-heals quickly given the
// schedule is now every 1 minute.
const CRON_LOCK_STALE_MINUTES = 5;

// Invoked by pg_cron (see README, "Passo manual obrigatorio pos-deploy")
// every 1 minute. Gated by CRON_SECRET so it can't be triggered by a random
// public POST. Folds the "stuck order" alert check into the same run
// instead of a second scheduled job.
export async function handleReconciliationCron(req: Request, deps: Deps = {}): Promise<Response> {
  const config = deps.config ?? loadConfig();

  if (!requireCronSecret(req, config)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = deps.supabase ?? createServiceClient(config);

  // Claims the run before doing any work, so a slow cycle still in flight
  // when the next minute's tick fires can't run concurrently with it and
  // double up API calls to Shopify/Melhor Envio.
  const staleBefore = new Date(Date.now() - CRON_LOCK_STALE_MINUTES * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("cron_locks")
    .update({ running_since: new Date().toISOString() })
    .eq("name", "reconciliation")
    .or(`running_since.is.null,running_since.lt.${staleBefore}`)
    .select("*");
  if (claimError) {
    console.log(JSON.stringify({ level: "error", err: String(claimError), msg: "cron_lock_claim_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!claimed || claimed.length === 0) {
    console.log(JSON.stringify({ msg: "reconciliation_cron_skipped_already_running" }));
    return new Response(JSON.stringify({ skipped: true, reason: "already_running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

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
  } finally {
    try {
      await supabase.from("cron_locks").update({ running_since: null }).eq("name", "reconciliation");
    } catch (err) {
      console.log(JSON.stringify({ level: "error", err: String(err), msg: "cron_lock_release_failed" }));
    }
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleReconciliationCron(req));
}
