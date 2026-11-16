import { randomUUID } from "node:crypto";
import { db, pool, autopilotJobsTable as jobs, projectsTable, workerServicesTable, aiCheckpointsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runAutopilot } from "./autopilot-process";
import { JobContext, jobContext, JobStoppedError, UncertainCallError, AIRequestRejectedError } from "./job-context";
import { startPollLoop, type PollObserver } from "../lib/poll-loop";
import { reserveOutputs, releaseOutputs, RenderBudgetPaused } from "../lib/render-budget";
import { redactError, nextFailure, permanentMediaFailure } from "../lib/failure-policy";
import { AIUsagePaused } from "../lib/ai-usage";

export const GLOBAL_SOURCE_LIMIT = 5;
const running = new Set<Promise<void>>();
const localSlots = new Set<number>();
let stopping = false;

export async function serviceHeartbeat(name: string) {
  await db.insert(workerServicesTable).values({ name, heartbeatAt: new Date() })
    .onConflictDoUpdate({ target: workerServicesTable.name, set: { heartbeatAt: new Date() } });
}
export async function runSlot(slot: number, run = runAutopilot, onlyOwner: string | null = null) {
  const connection = await pool.connect();
  let acquired = false;
  try {
    // Session locks cap actual live work even if a heartbeat expires while an old worker still runs.
    const lock = await connection.query("SELECT pg_try_advisory_lock(74000,$1) AS acquired", [slot]);
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired || stopping) return;
    const token = randomUUID();
    const claimed = await connection.query(`UPDATE autopilot_jobs SET status='processing', lease_token=$1, lease_until=now()+interval '3 minutes', updated_at=now()
      WHERE id=(SELECT id FROM autopilot_jobs WHERE cancel_requested=false AND ($2::text IS NULL OR owner_id=$2) AND
      ((status IN ('queued','retry','budget_paused') AND (retry_at IS NULL OR retry_at<=now()))
        OR (status='processing' AND lease_until < now())) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token, onlyOwner]);
    if (!claimed.rows.length) return;
    const id = Number(claimed.rows[0].id);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    const ctx = new JobContext(job!, token);
    const heartbeat = setInterval(() => {
      void db.update(jobs).set({ leaseUntil: new Date(Date.now() + 180000), updatedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.leaseToken, token), eq(jobs.cancelRequested, false))).returning()
        .then((rows) => { if (!rows.length) ctx.abort.abort(); }).catch(() => ctx.abort.abort());
    }, 10000);
    try {
      const [unfinished] = await db.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, id), eq(aiCheckpointsTable.status, "started"))).limit(1);
      if (unfinished) throw new UncertainCallError("An unfinished AI request may have been billed. Review and acknowledge before retrying; no new paid work was started.");
      await reserveOutputs(job!.ownerId, id, job!.originalClipId ? 1 : (job!.checkpoint.moments as unknown[] | undefined)?.length ?? 5, token);
      await jobContext.run(ctx, () => run(ctx, connection));
      await ctx.update({ status: "completed", progress: 100, stage: "ready", error: null, retryAt: null, failureKind: null });
      await releaseOutputs(job!.ownerId, id);
      if (!job!.originalClipId) await db.update(projectsTable).set({ status: "completed", stage: 5, progress: 100, error: null, updatedAt: new Date() }).where(eq(projectsTable.id, job!.projectId));
    } catch (error) {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, id));
      const [pendingAI] = await db.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, id), eq(aiCheckpointsTable.status, "started"))).limit(1);
      const retry = nextFailure(current?.failures ?? 0, new Date(), error instanceof AIRequestRejectedError ? error.notBefore : null);
      const stopped = error instanceof JobStoppedError || ctx.abort.signal.aborted;
      const status = current?.cancelRequested ? "cancelled"
        : error instanceof UncertainCallError || pendingAI ? "uncertain"
        : stopped ? "queued" : error instanceof RenderBudgetPaused ? "budget_paused"
        : error instanceof AIRequestRejectedError && error.status !== 429 || permanentMediaFailure(error) ? "failed" : retry.status;
      const failureKind = status === "uncertain" || pendingAI ? "uncertain_ai" : error instanceof AIUsagePaused ? "ai_usage_cap" : status === "budget_paused" ? "daily_cap"
        : error instanceof AIRequestRejectedError && error.status === 429 ? "rate_limited"
        : status === "failed" && retry.count < 2 ? "permanent" : status === "failed" ? "retry_exhausted" : "transient";
      const message = redactError(status === "uncertain" && !(error instanceof UncertainCallError)
        ? new UncertainCallError("An unfinished AI request may have been billed. Review and acknowledge before retrying; completed results are preserved.")
        : error);
      const retryAt = status === "budget_paused" ? (error as RenderBudgetPaused).resetAt : status === "retry" ? retry.retryAt
        : error instanceof AIRequestRejectedError && error.status === 429 ? error.notBefore : null;
      const counted = !["cancelled", "uncertain", "queued", "budget_paused"].includes(status);
      const changed = await db.update(jobs).set({ status, failureKind, retryAt, failures: counted ? retry.count : current?.failures ?? 0,
        error: status === "cancelled" ? "Cancelled. Completed clips and saved AI results are preserved." : message, updatedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.leaseToken, token))).returning({ id: jobs.id });
      if (changed.length && ["failed", "cancelled"].includes(status)) await releaseOutputs(job!.ownerId, id);
      if (changed.length && !job!.originalClipId) await db.update(projectsTable).set({ status, error: message, updatedAt: new Date() }).where(eq(projectsTable.id, job!.projectId));
      if (changed.length) logger.warn({ jobId: id, status, failureKind, failures: counted ? retry.count : current?.failures, retryAt, error: message }, "Autopilot job stopped");
      else logger.info({ jobId: id, status: "lease_lost", error: message }, "Superseded media worker did not change job state");
    } finally {
      clearInterval(heartbeat);
      await db.update(jobs).set({ leaseUntil: null, leaseToken: null }).where(and(eq(jobs.id, id), eq(jobs.leaseToken, token)));
    }
  } catch (error) {
    logger.error({ errorName: error instanceof Error ? error.name : "Unknown" }, "Media worker slot failed");
  } finally {
    if (acquired) await connection.query("SELECT pg_advisory_unlock(74000,$1)", [slot]).catch(() => {});
    connection.release();
  }
}
/** Adopt queued historical projects without deleting/replacing any existing media. */
export async function adoptLegacyJobs() {
  await db.execute(sql`INSERT INTO autopilot_jobs(owner_id,project_id,request_key,input_hash,status,error)
    SELECT p.owner_id,p.id,'legacy:'||p.id,'legacy',
      CASE WHEN p.status='processing' THEN 'uncertain' ELSE 'queued' END,
      CASE WHEN p.status='processing' THEN 'Historical processing was interrupted without checkpoints. Review possible AI usage before explicitly retrying.' ELSE NULL END
    FROM projects p WHERE p.status IN ('queued','processing') AND p.demo=false
    AND NOT EXISTS (SELECT 1 FROM autopilot_jobs j WHERE j.project_id=p.id) ON CONFLICT DO NOTHING`);
}
export function startPipelineWorker(observer?: PollObserver) {
  stopping = false;
  const tick = async () => {
    if (stopping) return;
    await adoptLegacyJobs();
    if (stopping) return;
    // Finish cancellations left queued or interrupted by a process crash.
    await db.execute(sql`UPDATE autopilot_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL
      WHERE cancel_requested=true AND (status IN ('queued','retry','budget_paused') OR (status='processing' AND (lease_until < now() OR lease_until IS NULL)))`);
    await db.execute(sql`DELETE FROM render_reservations r WHERE r.completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM autopilot_jobs j WHERE j.id=r.job_id AND j.status NOT IN ('failed','cancelled','completed'))`);
    for (let slot = 0; slot < GLOBAL_SOURCE_LIMIT; slot++) {
      if (stopping) break;
      if (running.size >= GLOBAL_SOURCE_LIMIT) break;
      if (localSlots.has(slot)) continue;
      localSlots.add(slot);
      const promise = runSlot(slot).finally(() => { running.delete(promise); localSlots.delete(slot); });
      running.add(promise);
    }
    // A bound listener or a heartbeat alone is not evidence that queue polling works.
    await serviceHeartbeat("media");
  };
  const stopPolling = startPollLoop(tick, 2000, () => logger.error("Media worker polling failed"), observer);
  return async () => {
    stopping = true;
    await stopPolling();
    await Promise.allSettled(running);
  };
}
