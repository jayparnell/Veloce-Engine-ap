import { randomUUID } from "node:crypto";
import { db, pool, autopilotJobsTable as jobs, projectsTable, workerServicesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runAutopilot } from "./autopilot-process";
import { JobContext, jobContext, JobStoppedError, UncertainCallError, AIRequestRejectedError } from "./job-context";
import { SourceIngestionError } from "./ingestion";

export const GLOBAL_SOURCE_LIMIT = 5;
const running = new Set<Promise<void>>();
const localSlots = new Set<number>();
let stopping = false;
const safeError = (error: unknown) => error instanceof SourceIngestionError || error instanceof UncertainCallError || error instanceof AIRequestRejectedError
  ? error.message.slice(0, 1800)
  : error instanceof Error && /^(Source |No |The rendered|Voiceover |Processing |You do not|Upload )/.test(error.message)
    ? error.message.slice(0, 500)
    : "Media processing failed. Saved results and completed clips were preserved; check source access and retry.";

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
      (status='queued' OR (status='processing' AND lease_until < now())) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token, onlyOwner]);
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
      await jobContext.run(ctx, () => run(ctx, connection));
      await ctx.update({ status: "completed", progress: 100, stage: "ready", error: null });
      if (!job!.originalClipId) await db.update(projectsTable).set({ status: "completed", stage: 5, progress: 100, error: null, updatedAt: new Date() }).where(eq(projectsTable.id, job!.projectId));
    } catch (error) {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, id));
      const status = current?.cancelRequested ? "cancelled" : error instanceof UncertainCallError ? "uncertain" : error instanceof JobStoppedError || ctx.abort.signal.aborted ? "queued" : "failed";
      const changed = await db.update(jobs).set({ status, error: status === "cancelled" ? "Cancelled. Completed clips and saved AI results are preserved." : safeError(error), updatedAt: new Date() }).where(and(eq(jobs.id, id), eq(jobs.leaseToken, token))).returning({ id: jobs.id });
      if (changed.length && !job!.originalClipId) await db.update(projectsTable).set({ status, error: safeError(error), updatedAt: new Date() }).where(eq(projectsTable.id, job!.projectId));
      logger.warn({ jobId: id, status, errorName: error instanceof Error ? error.name : "Unknown" }, "Autopilot job stopped");
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
export function startPipelineWorker() {
  let ticking = false;
  const tick = async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      await serviceHeartbeat("media");
      await adoptLegacyJobs();
      // Finish cancellations left queued or interrupted by a process crash.
      await db.execute(sql`UPDATE autopilot_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL
        WHERE cancel_requested=true AND (status='queued' OR (status='processing' AND (lease_until < now() OR lease_until IS NULL)))`);
      for (let slot = 0; slot < GLOBAL_SOURCE_LIMIT; slot++) {
        if (running.size >= GLOBAL_SOURCE_LIMIT) break;
        if (localSlots.has(slot)) continue;
        localSlots.add(slot);
        const promise = runSlot(slot).finally(() => { running.delete(promise); localSlots.delete(slot); });
        running.add(promise);
      }
    } finally { ticking = false; }
  };
  const interval = setInterval(() => { void tick().catch(() => logger.error("Media worker polling failed")); }, 2000);
  void tick();
  return async () => { stopping = true; clearInterval(interval); await Promise.allSettled(running); };
}
