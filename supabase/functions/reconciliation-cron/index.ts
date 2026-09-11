import { loadConfig } from "../_shared/config.ts";
import type { AppConfig } from "../_shared/config.ts";
import { requireCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/db.ts";
import {
  runReconciliation,
  checkStuckOrders,
  syncPostedOrders,
  retryStalledTracking,
  syncShippingCostDifferences,
  backfillShippingPrices,
} from "../_shared/reconciliation.ts";
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

// The conciliation job (see below) is a different shape entirely -- one
// sequential request per candidate tracking code, so a real run with a few
// dozen+ candidates can legitimately take a while (each is a real network
// round-trip to Melhor Envio).
const CONCILIATION_LOCK_STALE_MINUTES = 30;

// Claims a cron_locks row before doing any work, so a slow cycle still in
// flight when the next tick fires can't run concurrently with itself and
// double up API calls. Shared by both jobs below, each with its own row
// name/staleness so they never block each other.
async function claimLock(
  supabase: SupabaseClient,
  name: string,
  staleMinutes: number,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const { data: claimed, error } = await supabase
    .from("cron_locks")
    .update({ running_since: new Date().toISOString() })
    .eq("name", name)
    .or(`running_since.is.null,running_since.lt.${staleBefore}`)
    .select("*");
  if (error) throw error;
  return !!claimed && claimed.length > 0;
}

async function releaseLock(supabase: SupabaseClient, name: string): Promise<void> {
  try {
    await supabase.from("cron_locks").update({ running_since: null }).eq("name", name);
  } catch (err) {
    console.log(JSON.stringify({ level: "error", err: String(err), name, msg: "cron_lock_release_failed" }));
  }
}

// pg_net posts an empty body for the existing every-1-minute reconciliation
// job. The daily conciliation job (one-off SQL, see
// supabase/migrations/0012_melhorenvio_conciliation_cron.sql) posts to the
// exact same URL with `{"job": "melhorenvio_conciliation"}` instead -- one
// function, one deploy target, matching the "one fewer moving cron piece"
// choice already made for the stuck-order alert above. A malformed/empty
// body (or a parse failure) always falls through to the default job.
async function readJobBody(req: Request): Promise<{ job: string; offset: number }> {
  try {
    const body = await req.clone().json();
    const job = typeof body?.job === "string" ? body.job : "reconciliation";
    const offset = Number.isInteger(body?.offset) && body.offset >= 0 ? body.offset : 0;
    return { job, offset };
  } catch {
    return { job: "reconciliation", offset: 0 };
  }
}

// Backfill sob demanda, não agendado -- não tem cron_lock nem migração
// registrada pra ele (ver README "Passo manual opcional"). Chamado
// manualmente, uma vez por página, avançando `offset` a cada chamada até a
// resposta trazer hasMore: false. Empurra o valor_frete de pedidos que já
// existiam antes do bridge pro lucro-liquido estar no ar (esses nunca
// passaram por runShippingPipeline depois disso, então nunca dispararam
// reportShippingCost sozinhos). Sem lock: chamadas concorrentes só
// duplicam trabalho (idempotente do lado do lucro-liquido), nunca corrompem
// nada -- não vale a complexidade de um lock pra uma ferramenta manual.
async function runValorFreteBackfillJob(supabase: SupabaseClient, config: AppConfig, offset: number): Promise<Response> {
  try {
    const result = await backfillShippingPrices(supabase, config, offset);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.log(JSON.stringify({ level: "error", err: String(error), msg: "valor_frete_backfill_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// Runs once a day (the job's pg_cron schedule, not a code-level check here).
// No cron_lock-guarded overlap with the reconciliation job -- separate lock
// row, separate schedule -- so a slow run of one never delays the other.
async function runConciliationJob(supabase: SupabaseClient, config: AppConfig): Promise<Response> {
  const acquired = await claimLock(supabase, "melhorenvio_conciliation", CONCILIATION_LOCK_STALE_MINUTES);
  if (!acquired) {
    console.log(JSON.stringify({ msg: "conciliation_cron_skipped_already_running" }));
    return new Response(JSON.stringify({ skipped: true, reason: "already_running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await syncShippingCostDifferences(supabase, config);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.log(JSON.stringify({ level: "error", err: String(error), msg: "conciliation_cron_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  } finally {
    await releaseLock(supabase, "melhorenvio_conciliation");
  }
}

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

  const { job, offset } = await readJobBody(req);
  if (job === "melhorenvio_conciliation") {
    return runConciliationJob(supabase, config);
  }
  if (job === "melhorenvio_valor_frete_backfill") {
    return runValorFreteBackfillJob(supabase, config, offset);
  }

  let acquired: boolean;
  try {
    acquired = await claimLock(supabase, "reconciliation", CRON_LOCK_STALE_MINUTES);
  } catch (claimError) {
    console.log(JSON.stringify({ level: "error", err: String(claimError), msg: "cron_lock_claim_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!acquired) {
    console.log(JSON.stringify({ msg: "reconciliation_cron_skipped_already_running" }));
    return new Response(JSON.stringify({ skipped: true, reason: "already_running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Cheap, high-value steps first, each isolated — runReconciliation (one
    // Shopify GraphQL call per paid+unfulfilled order) is the slow one and
    // must not be able to eat the whole invocation's time budget before the
    // others run.
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        console.log(JSON.stringify({ level: "error", step: label, err: String(error), msg: "reconciliation_cron_step_failed" }));
      }
    };
    await step("syncPostedOrders", () => syncPostedOrders(supabase, config));
    await step("retryStalledTracking", () => retryStalledTracking(supabase, config));
    await step("checkStuckOrders", () => checkStuckOrders(supabase, config));
    let result: unknown = { scanned: 0, upserted: 0 };
    await step("runReconciliation", async () => {
      result = await runReconciliation(supabase, config);
    });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.log(JSON.stringify({ level: "error", err: String(error), msg: "reconciliation_cron_failed" }));
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    await releaseLock(supabase, "reconciliation");
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleReconciliationCron(req));
}
