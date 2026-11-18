import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db, autopilotJobsTable, projectsTable, aiUsageTable, type AutopilotJob, type Checkpoint } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { aiUsageContext, type UsageObservation } from "../lib/ai-usage";
import { usageCategory } from "../lib/ai-usage-metrics";

export class JobStoppedError extends Error {}
export const jobContext = new AsyncLocalStorage<JobContext>();
export class JobContext {
  readonly abort = new AbortController();
  private readonly inFlight = new Map<string, Promise<Checkpoint>>();
  constructor(public job: AutopilotJob, public token: string = randomUUID()) {}
  async check() {
    if (this.abort.signal.aborted) throw new JobStoppedError("Processing stopped.");
    const [row] = await db.select().from(autopilotJobsTable).where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token)));
    if (!row || row.cancelRequested || row.status !== "processing") {
      this.abort.abort();
      throw new JobStoppedError("Processing cancelled or worker lease lost.");
    }
    this.job = row;
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
    await this.saveResult(key, value);
  }
  private async saveResult(key: string, value: unknown) {
    const [row] = await db.update(autopilotJobsTable).set({ checkpoint: sql`${autopilotJobsTable.checkpoint} || ${JSON.stringify({ [key]: value })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token))).returning();
    if (!row) throw new JobStoppedError("Worker lease lost.");
    this.job = row;
  }
  async ai<T extends Checkpoint>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = this.result(key, fn);
    this.inFlight.set(key, promise);
    try { return await promise; } finally { this.inFlight.delete(key); }
  }
  private async result<T extends Checkpoint>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.check();
    const saved = this.job.checkpoint[`ai-result:${key}`];
    if (saved) return saved as T;
    // Passive metrics only: no billing admission, quota hold, started checkpoint or lock.
    const observation: UsageObservation = {};
    let status = "failed";
    try {
      const result = await aiUsageContext.run(observation, fn);
      status = "done";
      await this.saveResult(`ai-result:${key}`, result);
      await this.check();
      return result;
    } finally {
      try {
        const [project] = await db.select({ title: projectsTable.title }).from(projectsTable).where(eq(projectsTable.id, this.job.projectId));
        await db.insert(aiUsageTable).values({ ownerId: this.job.ownerId, jobId: this.job.id, projectId: this.job.projectId,
          sourceTitle: project?.title ?? "Removed source", language: this.job.language, category: usageCategory(this.job.language, key),
          callKey: key, status, model: observation.model, metrics: observation.metrics });
      } catch {
        // A reporting outage must never discard a successful response or conceal its error.
        logger.warn({ jobId: this.job.id }, "Could not record passive AI metrics");
      }
    }
  }
}
