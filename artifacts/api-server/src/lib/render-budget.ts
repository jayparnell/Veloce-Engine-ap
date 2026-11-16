import { pool, type PoolClient } from "@workspace/db";

type Connections = { connect(): Promise<PoolClient> };
export const RESET_TIMEZONE = "EST (fixed UTC-05:00)";
export class RenderBudgetPaused extends Error {
  constructor(public resetAt: Date) { super(`Daily Render Cap: insufficient clip allowance. Resumes at midnight EST (fixed UTC-05:00), ${resetAt.toISOString()}.`); }
}
export function renderDay(now = new Date()) {
  const day = new Date(now.getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const start = new Date(`${day}T05:00:00.000Z`);
  return { start, resetAt: new Date(start.getTime() + 86400000) };
}
export async function budgetTransaction<T>(owner: string, fn: (c: PoolClient) => Promise<T>, connections: Connections = pool) {
  const c = await connections.connect();
  try {
    await c.query("BEGIN");
    // All reservations, completions and cap changes use this owner lock.
    await c.query("SELECT pg_advisory_xact_lock(74006,hashtext($1))", [owner]);
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}
export async function budgetStatus(c: PoolClient, owner: string) {
  const { rows: [r] } = await c.query(`SELECT
    COALESCE((SELECT daily_render_cap FROM automation_settings WHERE owner_id=$1),15) AS cap,
    (SELECT count(*)::int FROM autopilot_jobs WHERE owner_id=$1 AND status='budget_paused') AS paused_jobs,
    count(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at >=
      (date_trunc('day',statement_timestamp() AT TIME ZONE INTERVAL '-05:00') AT TIME ZONE INTERVAL '-05:00'))::int AS completed,
    count(*) FILTER (WHERE completed_at IS NULL)::int AS reserved,
    (date_trunc('day',statement_timestamp() AT TIME ZONE INTERVAL '-05:00') AT TIME ZONE INTERVAL '-05:00') + interval '24 hours' AS reset_at
    FROM render_reservations WHERE owner_id=$1`, [owner]);
  return { dailyRenderCap: Number(r.cap), completed: Number(r.completed), reserved: Number(r.reserved),
    remaining: Math.max(0, Number(r.cap) - Number(r.completed) - Number(r.reserved)),
    resetAt: new Date(r.reset_at).toISOString(), resetTimezone: RESET_TIMEZONE, pausedJobs: Number(r.paused_jobs) };
}
export class RenderCapConflict extends Error {}
export async function setRenderCap(owner: string, cap: number, connections: Connections = pool) {
  return budgetTransaction(owner, async (c) => {
    const status = await budgetStatus(c, owner);
    if (cap < status.completed + status.reserved) throw new RenderCapConflict("Cap cannot be lower than completed plus reserved clips. Cancel pending work or wait for the daily reset.");
    await c.query("INSERT INTO automation_settings(owner_id,daily_render_cap) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET daily_render_cap=excluded.daily_render_cap", [owner, cap]);
    await c.query("UPDATE autopilot_jobs SET retry_at=NULL WHERE owner_id=$1 AND status='budget_paused'", [owner]);
    return budgetStatus(c, owner);
  }, connections);
}
export const outputKey = (jobId: number, index: number) => `job:${jobId}:${index}`;
/** The output row and its usage receipt commit together, fenced by the live job lease. */
export async function commitOutput(owner: string, jobId: number, index: number, token: string,
  write: (c: PoolClient) => Promise<unknown>, connections: Connections = pool) {
  return budgetTransaction(owner, async (c) => {
    const live = await c.query("SELECT id FROM autopilot_jobs WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND status='processing' AND cancel_requested=false FOR UPDATE", [jobId, owner, token]);
    if (!live.rowCount) throw new Error("Worker lease lost before output commit.");
    const reserved = await c.query("SELECT completed_at FROM render_reservations WHERE output_key=$1 AND owner_id=$2 FOR UPDATE", [outputKey(jobId, index), owner]);
    if (!reserved.rowCount) throw new Error("Output has no daily render reservation.");
    if (reserved.rows[0].completed_at) return false;
    await write(c);
    // Transaction start may precede a wait on the owner lock across midnight.
    await c.query("UPDATE render_reservations SET completed_at=statement_timestamp() WHERE output_key=$1", [outputKey(jobId, index)]);
    return true;
  }, connections);
}
/** Reserve the worst-case plan before analysis/translation; shrink once the saved plan is known.
 * Outstanding reservations carry over midnight, so work spanning reset never escapes the cap. */
export async function reserveOutputs(owner: string, jobId: number, count: number, token: string, connections: Connections = pool) {
  return budgetTransaction(owner, async (c) => {
    const live = await c.query("SELECT id FROM autopilot_jobs WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND status='processing' AND cancel_requested=false FOR UPDATE", [jobId, owner, token]);
    if (!live.rowCount) throw new Error("Worker lease lost before budget admission.");
    // Reap unused reservations of deleted jobs; completed receipts are never removed.
    await c.query("DELETE FROM render_reservations r WHERE owner_id=$1 AND completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM autopilot_jobs j WHERE j.id=r.job_id)", [owner]);
    const existing = await c.query("SELECT output_key FROM render_reservations WHERE owner_id=$1 AND job_id=$2", [owner, jobId]);
    const keys = Array.from({ length: count }, (_, i) => outputKey(jobId, i));
    const missing = keys.filter((key) => !existing.rows.some((r) => r.output_key === key));
    const status = await budgetStatus(c, owner);
    if (missing.length > status.remaining) throw new RenderBudgetPaused(new Date(status.resetAt));
    for (const key of missing) await c.query("INSERT INTO render_reservations(output_key,owner_id,job_id,moment_index) VALUES($1,$2,$3,$4)", [key, owner, jobId, Number(key.split(":")[2])]);
    await c.query("DELETE FROM render_reservations WHERE owner_id=$1 AND job_id=$2 AND completed_at IS NULL AND moment_index >= $3", [owner, jobId, count]);
  }, connections);
}
export async function releaseOutputs(owner: string, jobId: number, connections: Connections = pool) {
  await budgetTransaction(owner, async (c) => {
    await c.query("DELETE FROM render_reservations WHERE owner_id=$1 AND job_id=$2 AND completed_at IS NULL", [owner, jobId]);
  }, connections);
}
