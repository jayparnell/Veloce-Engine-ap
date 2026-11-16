import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db, autopilotJobsTable, aiCheckpointsTable, aiUsageTable, automationSettingsTable, projectsTable, type AutopilotJob, type Checkpoint } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { aiUsageContext, AIUsagePaused, usageWindow } from "../lib/ai-usage";
import { usageCategory } from "../lib/ai-usage-metrics";

export class UncertainCallError extends Error {}
export class JobStoppedError extends Error {}
export class AIRequestRejectedError extends Error {
  constructor(message: string, public status = 400, public notBefore: Date | null = null) { super(message); }
}
export const jobContext = new AsyncLocalStorage<JobContext>();
export class JobContext {
  readonly abort = new AbortController();
  constructor(public job: AutopilotJob, public token: string = randomUUID()) {}
  async check() {
    if (this.abort.signal.aborted) throw new JobStoppedError("Processing stopped.");
    const [row] = await db.select().from(autopilotJobsTable).where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token)));
    if (!row || row.cancelRequested || row.status !== "processing") {
      this.abort.abort();
      throw new JobStoppedError("Processing cancelled or worker lease lost.");
    }
  }
  async update(values: Partial<typeof autopilotJobsTable.$inferInsert>) {
    await this.check();
    const [row] = await db.update(autopilotJobsTable).set({ ...values, updatedAt: new Date() })
      .where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token))).returning();
    if (!row) throw new JobStoppedError("Worker lease lost.");
    this.job = row;
  }
  async save(key: string, value: unknown) {
    await this.check();
    const [row] = await db.update(autopilotJobsTable).set({ checkpoint: sql`${autopilotJobsTable.checkpoint} || ${JSON.stringify({ [key]: value })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token))).returning();
    if (!row) throw new JobStoppedError("Worker lease lost.");
    this.job = row;
  }
  async ai<T extends Checkpoint>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.check();
    const [existing] = await db.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
    if (existing?.status === "done" && existing.result) return existing.result as T;
    if (existing) throw new UncertainCallError("An earlier AI request may have been billed without a saved result. Review and acknowledge before retrying; completed results will be reused.");
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(74007,hashtext(${this.job.ownerId}))`);
      const [live] = await tx.select().from(autopilotJobsTable).where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token), eq(autopilotJobsTable.status, "processing"), eq(autopilotJobsTable.cancelRequested, false))).for("update");
      if (!live) throw new JobStoppedError("Worker lease lost before AI admission.");
      const [checkpoint] = await tx.insert(aiCheckpointsTable).values({ jobId: this.job.id, callKey: key, status: "started" }).onConflictDoNothing().returning();
      if (!checkpoint) throw new UncertainCallError("An AI request is already recorded. Review before retrying.");
      const [settings] = await tx.select().from(automationSettingsTable).where(eq(automationSettingsTable.ownerId, this.job.ownerId));
      const [usage] = await tx.select({ count: sql<number>`coalesce(sum(${aiUsageTable.units}),0)::int` }).from(aiUsageTable)
        .where(and(eq(aiUsageTable.ownerId, this.job.ownerId), usageWindow()));
      if (settings?.dailyRequestUnitLimit != null && usage!.count >= settings.dailyRequestUnitLimit) {
        // Polling a paused job never creates a receipt or calls a provider.
        throw new AIUsagePaused(new Date(Date.now() + 60000));
      }
      const [project] = await tx.select({ title: projectsTable.title }).from(projectsTable).where(and(eq(projectsTable.id, this.job.projectId), eq(projectsTable.ownerId, this.job.ownerId)));
      const [receipt] = await tx.insert(aiUsageTable).values({ ownerId: this.job.ownerId, jobId: this.job.id, projectId: this.job.projectId,
        sourceTitle: project?.title ?? "Removed source", language: this.job.language, category: usageCategory(this.job.language, key), callKey: key }).returning();
      await tx.update(aiCheckpointsTable).set({ usageId: receipt!.id }).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
      return receipt!;
    });
    const invocation = { id: created.id, responded: false };
    try {
      const result = await aiUsageContext.run(invocation, fn);
      // Save successful results even when cancellation arrived during the provider call.
      await db.transaction(async (tx) => {
        await tx.update(aiCheckpointsTable).set({ status: "done", result, updatedAt: new Date() })
          .where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key), eq(aiCheckpointsTable.usageId, created.id)));
        await tx.update(aiUsageTable).set({ status: "done" }).where(eq(aiUsageTable.id, created.id));
      });
      await this.check();
      return result;
    } catch (error) {
      if (error instanceof JobStoppedError) throw error;
      const detail = error as { status?: unknown; code?: unknown; headers?: Headers };
      logger.warn({ jobId: this.job.id, callKey: key, errorName: error instanceof Error ? error.name : "Unknown",
        httpStatus: typeof detail.status === "number" ? detail.status : undefined,
        providerCode: typeof detail.code === "string" && /^[a-z0-9_]{1,80}$/i.test(detail.code) ? detail.code : undefined }, "AI checkpoint did not obtain a durable result");
      if (!invocation.responded && typeof detail.status === "number" && [400, 401, 403, 404, 422, 429].includes(detail.status)) {
        await db.transaction(async (tx) => {
          await tx.delete(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key), eq(aiCheckpointsTable.usageId, created.id), eq(aiCheckpointsTable.status, "started")));
          await tx.update(aiUsageTable).set({ status: "rejected", units: 0 }).where(eq(aiUsageTable.id, created.id));
        });
        const after = detail.headers?.get?.("retry-after");
        const notBefore = after ? new Date(/^\d+(\.\d+)?$/.test(after) ? Date.now() + Number(after) * 1000 : after) : null;
        throw new AIRequestRejectedError(`AI provider rejected the request (HTTP ${detail.status}). ${detail.status === 429 ? "Rate or credit limit reached; retry after the provider permits it." : "Check integrated AI availability and request compatibility."} Saved results were preserved.`,
          detail.status, notBefore && Number.isFinite(notBefore.getTime()) ? notBefore : null);
      }
      await db.update(aiUsageTable).set({ status: "uncertain" }).where(eq(aiUsageTable.id, created.id));
      throw new UncertainCallError("AI request outcome is uncertain. No automatic repeat was made. Review possible usage, then acknowledge to retry the unfinished request.");
    }
  }
}
