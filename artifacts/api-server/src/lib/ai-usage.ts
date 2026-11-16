import { AsyncLocalStorage } from "node:async_hooks";
import { db, aiUsageTable, automationSettingsTable, type AIUsageMetrics } from "@workspace/db";
import { and, desc, eq, lt, or, sql, gt } from "drizzle-orm";
import { autopilotUsage } from "./autopilotQuota";
import { addMetrics, hasMetrics, managedMetrics, unknownMetrics } from "./ai-usage-metrics";
import { RenderBudgetPaused } from "./render-budget";

export class AIUsagePaused extends RenderBudgetPaused {
  constructor(resetAt: Date) {
    super(resetAt);
    this.message = "Managed AI request-unit limit reached. Saved results are reused; new calls pause until allowance is available or you increase the limit.";
  }
}
// Every simultaneous checkpoint has its own receipt, including overlapping transcription chunks.
export const aiUsageContext = new AsyncLocalStorage<{ id: number; responded: boolean }>();
export async function captureManagedUsage(response: unknown, model: string) {
  const invocation = aiUsageContext.getStore();
  if (invocation === undefined) return; // Non-durable legacy helpers are outside this ledger.
  invocation.responded = true;
  await db.update(aiUsageTable).set({ metrics: managedMetrics(response), model }).where(eq(aiUsageTable.id, invocation.id));
}
export const usageWindow = () => or(gt(aiUsageTable.createdAt, sql`statement_timestamp()-interval '24 hours'`), eq(aiUsageTable.status, "started"))!;

export async function usageReport(owner: string, before?: number) {
  // A short transaction gives counters, totals and history a consistent snapshot.
  return db.transaction(async (tx) => {
    const [settings] = await tx.select().from(automationSettingsTable).where(eq(automationSettingsTable.ownerId, owner));
    const jobs = (await tx.execute(autopilotUsage(owner))).rows[0]!;
    const window = await tx.select().from(aiUsageTable).where(and(eq(aiUsageTable.ownerId, owner), usageWindow()));
    const history = await tx.select().from(aiUsageTable).where(and(eq(aiUsageTable.ownerId, owner), before ? lt(aiUsageTable.id, before) : undefined)).orderBy(desc(aiUsageTable.id)).limit(101);
    const groups = (["source", "narration", "es", "pt"] as const).map((category) => {
      const rows = window.filter((row) => row.category === category);
      return { category, units: rows.reduce((sum, r) => sum + r.units, 0),
        unknown: rows.filter((r) => r.status !== "rejected" && !hasMetrics(r.metrics ?? unknownMetrics())).length,
        uncertain: rows.filter((r) => r.status === "started" || r.status === "uncertain").length,
        metrics: rows.reduce<AIUsageMetrics>((sum, r) => addMetrics(sum, r.metrics ?? unknownMetrics()), unknownMetrics()) };
    });
    const usedUnits = groups.reduce((sum, g) => sum + g.units, 0);
    const cap = settings?.dailyRequestUnitLimit ?? null;
    return { dailyRequestUnitLimit: cap, usedUnits, remainingUnits: cap === null ? null : Math.max(0, cap - usedUnits),
      activeJobs: Number(jobs.active), activeJobLimit: 10, remainingActiveJobs: Math.max(0, 10 - Number(jobs.active)),
      dailyJobs: Number(jobs.daily), dailyJobLimit: 20, remainingDailyJobs: Math.max(0, 20 - Number(jobs.daily)),
      groups, entries: history.slice(0, 100).map((r) => ({ ...r, metrics: r.metrics ?? unknownMetrics(), createdAt: r.createdAt.toISOString() })),
      nextBefore: history.length > 100 ? history[99]!.id : null,
      notice: "Rolling 24 hours, plus unresolved in-flight requests. One request unit per new durable AI checkpoint attempt; saved-result reuse costs no new units. Definitive rejections use zero units; uncertain attempts remain counted. Provider metrics are partial known subtotals, not Replit credits or currency. Audio tokens are included in token totals, not extra. Historical metrics and attempts removed before tracking began are unknown. Usage receipts survive media deletion. This limit is not an exact spending cap." };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function setUsageLimit(owner: string, limit: number | null) {
  await db.transaction(async (tx) => {
    // Same lock as checkpoint admissions; a setting change cannot race a paid admission.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74007,hashtext(${owner}))`);
    await tx.insert(automationSettingsTable).values({ ownerId: owner, dailyRequestUnitLimit: limit })
      .onConflictDoUpdate({ target: automationSettingsTable.ownerId, set: { dailyRequestUnitLimit: limit } });
    await tx.execute(sql`UPDATE autopilot_jobs SET retry_at=NULL WHERE owner_id=${owner} AND status='budget_paused' AND failure_kind='ai_usage_cap'`);
  });
  return usageReport(owner);
}
