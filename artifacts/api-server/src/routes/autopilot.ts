import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { db, autopilotJobsTable as jobs, projectsTable, generatedClipsTable as clips, mediaUploadsTable, aiCheckpointsTable, aiUsageTable, socialAccountsTable as accounts, publishQueueTable, workerServicesTable, campaignsTable, autopilotAdmissionsTable as admissions } from "@workspace/db";
import { eq, and, or, desc, inArray, sql, isNotNull } from "drizzle-orm";
import { LaunchAutopilotBody, LaunchAutopilotResponse, GetAutopilotSwarmResponse, ControlAutopilotJobBody, ControlAutopilotJobParams, CloneAndDubBody, GetAutopilotAccountsResponse, UpdateAutopilotAccountBody, UpdateAutopilotAccountParams, UpdateAutopilotAccountResponse, DisconnectAutopilotAccountParams, GetAutopilotScheduleResponse } from "@workspace/api-zod";
import { validSource } from "./studio";
import { PRESETS, validTimezone } from "../publishing/slots";
import { assignReadyClips } from "../publishing/allocator";
import { autopilotUsage } from "../lib/autopilotQuota";
import { budgetTransaction, budgetStatus, setRenderCap, RenderCapConflict } from "../lib/render-budget";
import { GetRenderBudgetResponse, UpdateRenderBudgetBody, UpdateRenderBudgetResponse } from "@workspace/api-zod";
import { redactError } from "../lib/failure-policy";
import { GetAutopilotUsageQueryParams, GetAutopilotUsageResponse, UpdateAIUsageLimitBody, UpdateAIUsageLimitResponse } from "@workspace/api-zod";
import { usageReport, setUsageLimit } from "../lib/ai-usage";
import { isUnifiedProvider } from "../publishing/unifiedPublisher";
import { unifiedAuthorized } from "../publishing/unified-settings";

const router: IRouter = Router();
router.use("/autopilot", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to launch real processing and manage your private clips." }); return; }
  next();
});
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
class InputError extends Error { constructor(message: string, public code = 400) { super(message); } }
router.get("/autopilot/usage", async (req, res): Promise<void> => {
  const input = GetAutopilotUsageQueryParams.safeParse(req.query);
  if (!input.success) { res.status(400).json({ error: "Invalid usage history cursor." }); return; }
  res.json(GetAutopilotUsageResponse.parse(await usageReport(req.workspaceId, input.data.before)));
});
router.patch("/autopilot/usage", async (req, res): Promise<void> => {
  const input = UpdateAIUsageLimitBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Use a whole request-unit limit from 0 to 10000, or null for no additional limit." }); return; }
  res.json(UpdateAIUsageLimitResponse.parse(await setUsageLimit(req.workspaceId, input.data.dailyRequestUnitLimit)));
});
router.get("/autopilot/render-budget", async (req, res): Promise<void> => {
  res.json(GetRenderBudgetResponse.parse(await budgetTransaction(req.workspaceId, (c) => budgetStatus(c, req.workspaceId))));
});
router.patch("/autopilot/render-budget", async (req, res): Promise<void> => {
  const input = UpdateRenderBudgetBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Daily Render Cap must be a whole number from 0 to 1000." }); return; }
  try { res.json(UpdateRenderBudgetResponse.parse(await setRenderCap(req.workspaceId, input.data.dailyRenderCap))); }
  catch (error) { if (!(error instanceof RenderCapConflict)) throw error; res.status(409).json({ error: error.message }); }
});
router.post("/autopilot/launch", async (req, res): Promise<void> => {
  const start = performance.now();
  const input = LaunchAutopilotBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Provide 1–5 sources and a unique request identifier." }); return; }
  const sources = [...new Set(input.data.sources.map((s) => s.trim()))];
  if (sources.some((s) => !validSource(s) && !/^\/objects\/[a-zA-Z0-9/_-]+$/.test(s))) {
    res.status(400).json({ error: "Use YouTube, Twitch or Kick HTTPS links, or a verified local MP4 upload." }); return;
  }
  const hash = digest(sources);
  try {
    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.workspaceId}))`);
      const existing = await tx.select().from(jobs).where(and(eq(jobs.ownerId, req.workspaceId), eq(jobs.requestKey, `${input.data.idempotencyKey}:0`)));
      if (existing.length) {
        if (existing[0]!.inputHash !== hash) throw new InputError("This request identifier was already used for different sources.", 409);
        const rows = await tx.select().from(jobs).where(and(eq(jobs.ownerId, req.workspaceId), eq(jobs.inputHash, hash), inArray(jobs.requestKey, sources.map((_, index) => `${input.data.idempotencyKey}:${index}`)))).orderBy(jobs.id);
        return rows.map((r) => r.id);
      }
      const [removed] = await tx.select().from(admissions).where(and(eq(admissions.ownerId, req.workspaceId), eq(admissions.requestKey, `${input.data.idempotencyKey}:0`))).limit(1);
      if (removed) throw new InputError("This launch was previously accepted and its project was removed. Use a new request identifier; deletion does not reset daily usage.", 409);
      const usage = await tx.execute(autopilotUsage(req.workspaceId));
      if (Number(usage.rows[0]?.active) + sources.length > 10 || Number(usage.rows[0]?.daily) + sources.length > 20) throw new InputError("Workspace quota reached: 10 active jobs and 20 source/dub jobs per rolling 24 hours.", 429);
      const paths = sources.filter((s) => s.startsWith("/objects/"));
      if (paths.length) {
        const uploads = await tx.select().from(mediaUploadsTable).where(and(eq(mediaUploadsTable.ownerId, req.workspaceId), eq(mediaUploadsTable.finalized, true), eq(mediaUploadsTable.contentType, "video/mp4"), inArray(mediaUploadsTable.objectPath, paths)));
        if (uploads.length !== paths.length) throw new InputError("Upload and verify each MP4 in your account before launching.");
      }
      const [campaign] = await tx.select({ id: campaignsTable.id }).from(campaignsTable).where(and(eq(campaignsTable.ownerId, req.workspaceId), eq(campaignsTable.status, "active"), eq(campaignsTable.demo, false), isNotNull(campaignsTable.audioPath))).orderBy(desc(campaignsTable.id)).limit(1);
      const projects = await tx.insert(projectsTable).values(sources.map((sourceUrl) => ({
        ownerId: req.workspaceId, sourceUrl, title: "Autopilot source", mode: "commentary", clipCount: 3, demo: false, campaignId: campaign?.id,
      }))).returning();
      const rows = await tx.insert(jobs).values(projects.map((p, index) => ({ ownerId: req.workspaceId, projectId: p.id, requestKey: `${input.data.idempotencyKey}:${index}`, inputHash: hash }))).returning();
      await tx.insert(admissions).values(rows.map((j) => ({ ownerId: j.ownerId, requestKey: j.requestKey, inputHash: j.inputHash, jobId: j.id, projectId: j.projectId })));
      return rows.map((r) => r.id);
    });
    const acceptedMs = performance.now() - start;
    res.set("Server-Timing", `accept;dur=${acceptedMs.toFixed(2)}`);
    res.status(202).json(LaunchAutopilotResponse.parse({ jobIds: ids, acceptedMs }));
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    res.status(error.code).json({ error: error.message });
  }
});
router.get("/autopilot/swarm", async (req, res): Promise<void> => {
  // Keep every active job visible, even when an older uncertain source predates the recent history.
   const rows = await db.select({ job: jobs, project: projectsTable }).from(jobs).innerJoin(projectsTable, eq(jobs.projectId, projectsTable.id)).where(eq(jobs.ownerId, req.workspaceId)).orderBy(sql`CASE WHEN ${jobs.status} IN ('queued','processing','uncertain','retry','budget_paused') THEN 0 ELSE 1 END`, desc(jobs.id)).limit(110);
  const ready = rows.length ? await db.select().from(clips).where(and(eq(clips.ownerId, req.workspaceId), or(inArray(clips.jobId, rows.map(({ job }) => job.id)), inArray(clips.regenerationJobId, rows.map(({ job }) => job.id))))) : [];
  res.json(GetAutopilotSwarmResponse.parse(rows.map(({ job, project }) => {
    const done = ready.filter((c) => c.jobId === job.id);
    const moments = job.checkpoint.moments as unknown[] | undefined;
    const count = job.originalClipId ? 1 : moments?.length ?? project.clipCount;
     return { ...job, error: job.error ? redactError(new Error(job.error)) : null, retryAt: job.retryAt?.toISOString() ?? null, sourceUrl: project.sourceUrl, title: job.checkpoint.regeneration ? `Editor regeneration · clip #${job.originalClipId}` : project.title, createdAt: job.createdAt.toISOString(),
      clips: Array.from({ length: count }, (_, index) => {
        const clip = job.checkpoint.regeneration
          ? ready.find((c) => c.id === job.originalClipId && c.regenerationJobId === job.id && c.renderInfo?.version === (job.checkpoint.regeneration as { version: number }).version)
          : done.find((c) => c.momentIndex === index);
        return { index, language: job.language, status: clip ? "ready" : job.checkpoint[`clip:${index}:status`] ?? (job.status === "processing" ? "waiting" : job.status),
          ...(clip ? { clip: { ...clip, createdAt: clip.createdAt.toISOString() } } : {}) };
      }) };
  })));
});
router.post("/autopilot/jobs/:id/action", async (req, res): Promise<void> => {
  const params = ControlAutopilotJobParams.safeParse(req.params), input = ControlAutopilotJobBody.safeParse(req.body);
  if (!params.success || !input.success) { res.status(400).json({ error: "Invalid job action." }); return; }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.workspaceId}))`);
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, params.data.id), eq(jobs.ownerId, req.workspaceId))).for("update");
    if (!job) return { code: 404, message: "Job not found." };
    if (input.data.action === "cancel") {
      if (job.status === "completed") return { code: 409, message: "This job already completed." };
      await tx.update(jobs).set({ cancelRequested: true, ...(job.status !== "processing" ? { status: "cancelled" } : {}) }).where(eq(jobs.id, job.id));
    } else {
      if (!["failed", "cancelled", "uncertain"].includes(job.status) || (job.leaseUntil && job.leaseUntil > new Date())) return { code: 409, message: "Wait for this worker to stop before retrying." };
       if (job.retryAt && job.retryAt > new Date()) return { code: 409, message: `Provider restrictions prevent a repeat before ${job.retryAt.toISOString()}.` };
      if (job.status === "uncertain" && input.data.action !== "acknowledge-uncertain") return { code: 409, message: "Acknowledge possible previous AI usage before repeating unfinished calls." };
       const [unfinished] = await tx.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, job.id), eq(aiCheckpointsTable.status, "started"))).limit(1);
       if (unfinished && input.data.action !== "acknowledge-uncertain") return { code: 409, message: "A cancelled or failed job still has an uncertain AI request. Acknowledge possible usage before repeating it." };
      const usage = await tx.execute(autopilotUsage(req.workspaceId));
      if (job.status !== "uncertain" && Number(usage.rows[0]?.active) >= 10) return { code: 429, message: "Ten jobs are already active. Wait before reactivating another source." };
      if (input.data.action === "acknowledge-uncertain") {
        // Preserve the earlier potentially charged attempt when authorizing a new one.
        const pending = await tx.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, job.id), eq(aiCheckpointsTable.status, "started")));
        const ids = pending.flatMap((c) => c.usageId == null ? [] : [c.usageId]);
        if (ids.length) await tx.update(aiUsageTable).set({ status: "uncertain" }).where(and(eq(aiUsageTable.ownerId, req.workspaceId), inArray(aiUsageTable.id, ids)));
        await tx.delete(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, job.id), eq(aiCheckpointsTable.status, "started")));
      }
       await tx.update(jobs).set({ status: "queued", error: null, retryAt: null, failureKind: null, cancelRequested: false, leaseToken: null, leaseUntil: null }).where(eq(jobs.id, job.id));
    }
    return { code: 200, message: input.data.action === "cancel" ? "Cancellation requested. Completed clips are preserved." : "Job queued with saved results. Unfinished acknowledged AI calls may incur new usage." };
  });
  res.status(result.code).json(result.code === 200 ? { message: result.message } : { error: result.message });
});
router.post("/autopilot/dub", async (req, res): Promise<void> => {
  const start = performance.now(), input = CloneAndDubBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Choose 1–20 ready original clips." }); return; }
  try {
    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.workspaceId}))`);
      const originals = await tx.select().from(clips).where(and(eq(clips.ownerId, req.workspaceId), inArray(clips.id, [...new Set(input.data.clipIds)])));
      if (originals.length !== new Set(input.data.clipIds).size || originals.some((c) => c.demo || !c.objectPath || c.language !== "en" || !c.jobId)) throw new InputError("Select ready English Autopilot clips. Historical clips remain playable but need a new source run to support recoverable dubbing.");
      const existing = (await tx.select().from(jobs).where(and(eq(jobs.ownerId, req.workspaceId), inArray(jobs.originalClipId, originals.map((c) => c.id))))).filter((j) => !j.checkpoint.regeneration);
      const pending = originals.flatMap((clip) => ["es", "pt"].filter((language) => !existing.some((j) => j.originalClipId === clip.id && j.language === language)).map((language) => ({ ownerId: req.workspaceId, projectId: clip.projectId, originalClipId: clip.id, language, inputHash: digest([clip.id, language]), requestKey: `dub:${clip.id}:${language}` })));
      const usage = await tx.execute(autopilotUsage(req.workspaceId));
      if (Number(usage.rows[0]?.active) + pending.length > 10 || Number(usage.rows[0]?.daily) + pending.length > 20) throw new InputError("Dub jobs exceed your 10 active / 20 daily job quota. Select fewer clips or wait.", 429);
      const added = pending.length ? await tx.insert(jobs).values(pending).returning() : [];
      if (added.length) await tx.insert(admissions).values(added.map((j) => ({ ownerId: j.ownerId, requestKey: j.requestKey, inputHash: j.inputHash, jobId: j.id, projectId: j.projectId })));
      return [...existing, ...added].map((j) => j.id);
    });
    res.status(202).json(LaunchAutopilotResponse.parse({ jobIds: ids, acceptedMs: performance.now() - start }));
  } catch (error) { if (!(error instanceof InputError)) throw error; res.status(error.code).json({ error: error.message }); }
});
export function publicAccount(a: typeof accounts.$inferSelect) {
  return { id: a.id, provider: a.provider, postingRoute: a.postingRoute, platform: a.platform, handle: a.handle, connected: a.connected, approved: a.approved,
    autoEnabled: a.autoEnabled, includeDubs: a.includeDubs, timezone: a.timezone, slots: a.slots,
    message: a.error ?? (!a.connected ? "Reconnect this account. Exports remain available." : !a.approved ? "Platform approval is required." : a.autoEnabled ? "Automatic publishing enabled while publisher service is running." : "Authorized. Automatic publishing is off.") };
}
router.get("/autopilot/accounts", async (req, res): Promise<void> => {
  res.json(GetAutopilotAccountsResponse.parse((await db.select().from(accounts).where(eq(accounts.ownerId, req.workspaceId))).map(publicAccount)));
});
router.patch("/autopilot/accounts/:id", async (req, res): Promise<void> => {
  const params = UpdateAutopilotAccountParams.safeParse(req.params), input = UpdateAutopilotAccountBody.safeParse(req.body);
  if (!params.success || !input.success || !validTimezone(input.data.timezone)) { res.status(400).json({ error: "Use an IANA timezone and 1–12 distinct HH:mm slots." }); return; }
  const [account] = await db.select().from(accounts).where(and(eq(accounts.ownerId, req.workspaceId), eq(accounts.id, params.data.id)));
  if (!account) { res.status(404).json({ error: "Account not found." }); return; }
  const authorized = isUnifiedProvider(account.postingRoute) ? await unifiedAuthorized(account.ownerId, account.postingRoute) : Boolean(account.encryptedTokens);
  if (input.data.autoEnabled && (!account.connected || !account.approved || !authorized)) { res.status(409).json({ error: "Connect an approved account and configure its selected posting route before explicitly enabling automatic posting. ZIP export remains available." }); return; }
  const [row] = await db.update(accounts).set({ ...input.data, ...(!account.autoEnabled && input.data.autoEnabled ? { autoEnabledAt: new Date() } : {}), slots: [...new Set(input.data.slots)].sort() }).where(eq(accounts.id, account.id)).returning();
  if (row!.autoEnabled) await assignReadyClips(account.ownerId, account.id);
  res.json(UpdateAutopilotAccountResponse.parse(publicAccount(row!)));
});
router.delete("/autopilot/accounts/:id", async (req, res): Promise<void> => {
  const input = DisconnectAutopilotAccountParams.safeParse(req.params);
  if (!input.success) { res.status(400).json({ error: "Invalid account." }); return; }
  const [row] = await db.update(accounts).set({ connected: false, autoEnabled: false, encryptedTokens: null, error: "Disconnected. Revoke access with the provider if desired." }).where(and(eq(accounts.id, input.data.id), eq(accounts.ownerId, req.workspaceId))).returning();
  if (!row) { res.status(404).json({ error: "Account not found." }); return; }
  res.sendStatus(204);
});
router.get("/autopilot/schedule", async (req, res): Promise<void> => {
  const [entries, services] = await Promise.all([
    db.select({ work: publishQueueTable, clip: clips, account: accounts }).from(publishQueueTable).innerJoin(clips, eq(clips.id, publishQueueTable.clipId)).innerJoin(accounts, eq(accounts.id, publishQueueTable.accountId)).where(eq(publishQueueTable.ownerId, req.workspaceId)).orderBy(publishQueueTable.scheduledAt),
    db.select().from(workerServicesTable),
  ]);
  const running = (name: string) => services.some((s) => s.name === name && Date.now() - s.heartbeatAt.getTime() < 90000);
  res.json(GetAutopilotScheduleResponse.parse({
     entries: entries.map(({ work, clip, account }) => ({ ...work, error: work.error ? redactError(new Error(work.error)) : null, retryAt: work.retryAt?.toISOString() ?? null, title: clip.title, language: clip.language, platform: account.platform, handle: account.handle, scheduledAt: work.scheduledAt.toISOString() })),
    presets: PRESETS, workerRunning: running("media"), publisherRunning: running("publisher"),
    serviceMessage: "Publishing checks due work every 60 seconds only while the dedicated service is running. Sleep or stopped services delay posts. Presets are configurable, not performance claims. Existing reservations keep their original timezone and instant.",
  }));
});
export default router;
