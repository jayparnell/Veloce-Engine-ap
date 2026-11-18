import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db, autopilotJobsTable, aiCheckpointsTable, aiUsageTable, automationSettingsTable, projectsTable, type AutopilotJob, type Checkpoint } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { aiUsageContext, AIUsagePaused, usageWindow } from "../lib/ai-usage";
import { usageCategory } from "../lib/ai-usage-metrics";
import { AIRetryScheduled, AIRetriesExhausted, MAX_AI_ATTEMPTS, attemptKey, requestKey, retryDate } from "./ai-retry";
export { UncertainCallError } from "./ai-retry";

export class JobStoppedError extends Error {}
export class AIRequestRejectedError extends Error {
  constructor(message: string, public status = 400, public notBefore: Date | null = null) { super(message); }
}
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
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = this.attempt(key, fn);
    this.inFlight.set(key, promise);
    try { return await promise; } finally { this.inFlight.delete(key); }
  }
  private async attempt<T extends Checkpoint>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.check();
    const [existing] = await db.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
    if (existing?.status === "done" && existing.result) return existing.result as T;
    const admission = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(74007,hashtext(${this.job.ownerId}))`);
      const [live] = await tx.select().from(autopilotJobsTable).where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token), eq(autopilotJobsTable.status, "processing"), eq(autopilotJobsTable.cancelRequested, false))).for("update");
      if (!live) throw new JobStoppedError("Worker lease lost before AI admission.");
      const [prior] = await tx.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
      if (prior?.status === "done" && prior.result) return { cached: prior.result };
      const saved = live.checkpoint[attemptKey(key)] as { attempt: number; retryAt?: string } | undefined;
      const attempt = saved?.attempt ?? (prior ? 1 : 0);
      if (attempt < MAX_AI_ATTEMPTS && saved?.retryAt && Date.parse(saved.retryAt) > Date.now()) return { retry: { at: new Date(saved.retryAt), attempt } };
      // A process may have died after sending the request. Keep that receipt, but no manual hold.
      if (prior?.usageId) await tx.update(aiUsageTable).set({ status: "uncertain" })
        .where(and(eq(aiUsageTable.id, prior.usageId), eq(aiUsageTable.status, "started")));
      if (prior) await tx.delete(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key)));
      if (attempt >= MAX_AI_ATTEMPTS) return { exhausted: true };
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
      await tx.insert(aiCheckpointsTable).values({ jobId: this.job.id, callKey: key, status: "started", usageId: receipt!.id });
      await tx.update(autopilotJobsTable).set({ checkpoint: sql`${autopilotJobsTable.checkpoint} || ${JSON.stringify({ [attemptKey(key)]: { attempt: attempt + 1 } })}::jsonb` })
        .where(eq(autopilotJobsTable.id, this.job.id));
      return { receipt: receipt!, attempt: attempt + 1 };
    });
    if (admission.cached) return admission.cached as T;
    if (admission.retry) throw new AIRetryScheduled(admission.retry.at, admission.retry.attempt);
    if (admission.exhausted) throw new AIRetriesExhausted();
    const created = admission.receipt!;
    const invocation = { id: created.id, responded: false, requestKey: requestKey(this.job.ownerId, this.job.id, key) };
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
      const detail = (error && typeof error === "object" ? error : {}) as { status?: unknown; code?: unknown; headers?: Headers; localFallback?: boolean };
      logger.warn({ jobId: this.job.id, callKey: key, errorName: error instanceof Error ? error.name : "Unknown",
        httpStatus: typeof detail.status === "number" ? detail.status : undefined,
        providerCode: typeof detail.code === "string" && /^[a-z0-9_]{1,80}$/i.test(detail.code) ? detail.code : undefined }, "AI checkpoint did not obtain a durable result");
      const rejected = !invocation.responded && typeof detail.status === "number" && [400, 401, 403, 404, 422, 429].includes(detail.status);
      const permanent = detail.localFallback === true || !invocation.responded && typeof detail.status === "number" && [400, 401, 403, 404, 422].includes(detail.status);
      const notBefore = retryDate(admission.attempt!, detail.headers);
      await db.transaction(async (tx) => {
          await tx.delete(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, this.job.id), eq(aiCheckpointsTable.callKey, key), eq(aiCheckpointsTable.usageId, created.id), eq(aiCheckpointsTable.status, "started")));
          await tx.update(aiUsageTable).set({ status: rejected ? "rejected" : invocation.responded ? "done" : "uncertain", ...(rejected ? { units: 0 } : {}) }).where(eq(aiUsageTable.id, created.id));
          await tx.update(autopilotJobsTable).set({ checkpoint: sql`${autopilotJobsTable.checkpoint} || ${JSON.stringify({ [attemptKey(key)]: { attempt: admission.attempt, retryAt: notBefore.toISOString() } })}::jsonb` })
            .where(and(eq(autopilotJobsTable.id, this.job.id), eq(autopilotJobsTable.leaseToken, this.token)));
        });
      await this.check();
      if (detail.localFallback) throw new AIRequestRejectedError("AI transcription returned unusable word timestamps. CPU transcription will be attempted.", 422);
      if (permanent) throw new AIRequestRejectedError(`AI provider rejected the request (HTTP ${detail.status}). Check the selected provider's key, access and request compatibility. Saved results were preserved.`, Number(detail.status));
      if (admission.attempt! >= MAX_AI_ATTEMPTS) throw new AIRetriesExhausted();
      throw new AIRetryScheduled(notBefore, admission.attempt!);
    }
  }
}
