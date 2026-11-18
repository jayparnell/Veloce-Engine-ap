import { AsyncLocalStorage } from "node:async_hooks";
import { db, aiUsageTable, type AIUsageMetrics } from "@workspace/db";
import { and, desc, eq, lt, or, sql, gt } from "drizzle-orm";
import { autopilotUsage } from "./autopilotQuota";
import { addMetrics, hasMetrics, managedMetrics, unknownMetrics } from "./ai-usage-metrics";
// Every simultaneous checkpoint has its own receipt, including overlapping transcription chunks.
export type UsageObservation = { model?: string; metrics?: AIUsageMetrics };
export const aiUsageContext = new AsyncLocalStorage<UsageObservation>();
export async function captureManagedUsage(response: unknown, model: string) {
  const invocation = aiUsageContext.getStore();
  if (invocation === undefined) return; // Non-durable legacy helpers are outside this ledger.
  invocation.metrics = managedMetrics(response);
  invocation.model = model;
}
export const usageWindow = () => gt(aiUsageTable.createdAt, sql`statement_timestamp()-interval '24 hours'`);

export async function usageReport(owner: string, before?: number) {
  // A short transaction gives counters, totals and history a consistent snapshot.
  return db.transaction(async (tx) => {
    const jobs = (await tx.execute(autopilotUsage(owner))).rows[0]!;
    const window = await tx.select().from(aiUsageTable).where(and(eq(aiUsageTable.ownerId, owner), usageWindow()));
    const history = await tx.select().from(aiUsageTable).where(and(eq(aiUsageTable.ownerId, owner), before ? lt(aiUsageTable.id, before) : undefined)).orderBy(desc(aiUsageTable.id)).limit(101);
    const groups = (["source", "narration", "es", "pt"] as const).map((category) => {
      const rows = window.filter((row) => row.category === category);
      return { category, units: rows.reduce((sum, r) => sum + r.units, 0),
        unknown: rows.filter((r) => r.status !== "rejected" && !hasMetrics(r.metrics ?? unknownMetrics())).length,
        uncertain: 0,
        metrics: rows.reduce<AIUsageMetrics>((sum, r) => addMetrics(sum, r.metrics ?? unknownMetrics()), unknownMetrics()) };
    });
    const usedUnits = groups.reduce((sum, g) => sum + g.units, 0);
    const cap = null;
    return { dailyRequestUnitLimit: cap, usedUnits, remainingUnits: cap === null ? null : Math.max(0, cap - usedUnits),
      activeJobs: Number(jobs.active), activeJobLimit: 10, remainingActiveJobs: Math.max(0, 10 - Number(jobs.active)),
      dailyJobs: Number(jobs.daily), dailyJobLimit: 20, remainingDailyJobs: Math.max(0, 20 - Number(jobs.daily)),
      groups, entries: history.slice(0, 100).map((r) => ({ ...r, metrics: r.metrics ?? unknownMetrics(), createdAt: r.createdAt.toISOString() })),
      nextBefore: history.length > 100 ? history[99]!.id : null,
      notice: "Direct OpenAI only. Reporting is passive and never blocks AI requests. Internal units count logical calls, not API retries or currency. Calls retry twice with a three-second delay. Provider metrics are partial known subtotals; historical entries remain available. OpenAI determines actual charges." };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
