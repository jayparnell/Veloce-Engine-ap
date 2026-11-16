import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db, autopilotJobsTable, aiCheckpointsTable, type AutopilotJob, type Checkpoint } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export class UncertainCallError extends Error {}
export class JobStoppedError extends Error {}
export class AIRequestRejectedError extends Error {}
export const jobContext = new AsyncLocalStorage<JobContext>();
export class JobContext {
  readonly abort = new AbortController();
  constructor(public job: AutopilotJob, public token = randomUUID()) {}
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
    const [created] = await db.insert(aiCheckpointsTable).values({ jobId: this.job.id, callKey: key, status: "started" }).onConflictDoNothing().returning();
    if (!created) throw new UncertainCallError("An AI request is already recorded. Review before retrying.");
    try {
      const result = await fn();
      // Save successful results even when cancellation arrived during the provider call.
      await db.update(aiCheckpointsTable).set({ status: "done", result, updatedAt: new Date() })
        .where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
      await this.check();
      return result;
    } catch (error) {
      if (error instanceof JobStoppedError) throw error;
      const detail = error as { status?: unknown; code?: unknown };
      logger.warn({ jobId: this.job.id, callKey: key, errorName: error instanceof Error ? error.name : "Unknown",
        httpStatus: typeof detail.status === "number" ? detail.status : undefined,
        providerCode: typeof detail.code === "string" && /^[a-z0-9_]{1,80}$/i.test(detail.code) ? detail.code : undefined }, "AI checkpoint did not obtain a durable result");
      if (typeof detail.status === "number" && [400, 401, 403, 404, 422, 429].includes(detail.status)) {
        await db.delete(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key), eq(aiCheckpointsTable.status, "started")));
        throw new AIRequestRejectedError(`AI provider rejected the request (HTTP ${detail.status}). ${detail.status === 429 ? "Rate or credit limit reached; retry after the provider permits it." : "Check integrated AI availability and request compatibility."} Saved results were preserved.`);
      }
      throw new UncertainCallError("AI request outcome is uncertain. No automatic repeat was made. Review possible usage, then acknowledge to retry the unfinished request.");
    }
  }
}
