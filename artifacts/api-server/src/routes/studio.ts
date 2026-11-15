import { Router, type IRouter } from "express";
import { db, projectsTable, generatedClipsTable, campaignsTable, analyticsLogsTable } from "@workspace/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import { GetStudioSummaryResponse, ListTrendingSourcesResponse, ListProjectsResponse, CreateProjectBody, CreateProjectResponse, GetProjectParams, GetProjectResponse, DeleteProjectParams, ListClipsResponse, UpdateClipBody, UpdateClipParams, UpdateClipResponse, DeleteClipParams, CreateExportBody, CreateExportResponse } from "@workspace/api-zod";
import { trendingSources } from "../lib/demo";
import { finalizeUpload } from "../lib/uploads";
import { ownedFile } from "../lib/mediaStorage";
import { buildExport } from "../pipeline/export";
import { getCapabilities } from "../lib/capabilities";

const router: IRouter = Router();
const jsonDates = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
const acceptableHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "twitch.tv", "www.twitch.tv", "kick.com", "www.kick.com"]);
export function validSource(source: string) {
  try { const url = new URL(source); return url.protocol === "https:" && acceptableHosts.has(url.hostname) && !url.username && !url.password && !url.port; } catch { return false; }
}
router.get("/studio/summary", async (req, res): Promise<void> => {
  const [clips, projects, campaigns, activity] = await Promise.all([
    db.select().from(generatedClipsTable).where(eq(generatedClipsTable.ownerId, req.workspaceId)),
    db.select().from(projectsTable).where(eq(projectsTable.ownerId, req.workspaceId)),
    db.select().from(campaignsTable).where(eq(campaignsTable.ownerId, req.workspaceId)),
    db.select().from(analyticsLogsTable).where(eq(analyticsLogsTable.ownerId, req.workspaceId)).orderBy(desc(analyticsLogsTable.id)).limit(8),
  ]);
  res.json(GetStudioSummaryResponse.parse({
    totalClips: clips.length, readyClips: clips.filter((c) => c.status === "ready").length,
    activeBatches: projects.filter((p) => ["queued", "processing"].includes(p.status)).length,
    averageScore: clips.length ? Math.round(clips.reduce((sum, c) => sum + c.score, 0) / clips.length) : 0,
    estimatedPayout: Math.round(campaigns.reduce((sum, c) => sum + Math.min(c.budget, c.views * c.cpm / 1000), 0) * 100) / 100,
    demo: !clips.some((c) => !c.demo), activity: activity.map(jsonDates),
    capabilities: getCapabilities(),
  }));
});
router.get("/trending", (_req, res) => { res.json(ListTrendingSourcesResponse.parse(trendingSources)); });
router.get("/projects", async (req, res): Promise<void> => {
  res.json(ListProjectsResponse.parse((await db.select().from(projectsTable).where(eq(projectsTable.ownerId, req.workspaceId)).orderBy(desc(projectsTable.id))).map(jsonDates)));
});
router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Provide a source URL, transformation mode, and 1–4 clips." }); return; }
  const input = parsed.data;
  if (!input.rightsConfirmed) { res.status(400).json({ error: "Confirm you have permission to process and reuse this footage." }); return; }
  if (!input.demo && !req.isAuthenticated()) { res.status(401).json({ error: "Log in to process your own media, or try a demo batch." }); return; }
  if (!input.demo) {
    const capabilities = getCapabilities();
    if (!capabilities.media || !capabilities.ai || !capabilities.uploads) { res.status(503).json({ error: "Real processing requires media tools, integrated AI and App Storage. Check Settings → Capabilities." }); return; }
  }
  if (!input.demo && !validSource(input.sourceUrl) && !/^\/objects\/[a-zA-Z0-9/_-]+$/.test(input.sourceUrl)) {
    res.status(400).json({ error: "Use a YouTube, Twitch or Kick HTTPS URL, or upload an MP4 file." }); return;
  }
  if (input.sourceUrl.startsWith("/objects/") && !input.demo) {
    try { await finalizeUpload(input.sourceUrl, req.workspaceId); await ownedFile(input.sourceUrl, req.workspaceId); }
    catch { res.status(400).json({ error: "Upload the source video to your own account first." }); return; }
  }
  if (input.campaignId) {
    const [campaign] = await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, input.campaignId), eq(campaignsTable.ownerId, req.workspaceId)));
    if (!campaign || campaign.status !== "active") { res.status(400).json({ error: "Choose an active campaign in your workspace." }); return; }
  }
  if (input.mode === "bounty" && !input.campaignId) { res.status(400).json({ error: "Select a sponsor campaign for Bounty mode." }); return; }
  const created = await db.transaction(async (tx) => {
    const { sql } = await import("drizzle-orm");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.workspaceId}))`);
    const active = await tx.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.ownerId, req.workspaceId), inArray(projectsTable.status, ["queued", "processing"])));
    if (active.length >= 2) return null;
    const [row] = await tx.insert(projectsTable).values({
      ownerId: req.workspaceId, title: input.demo ? "Demo transformation batch" : "New source batch",
      sourceUrl: input.sourceUrl, mode: input.mode, clipCount: input.clipCount, campaignId: input.campaignId,
      demo: !!input.demo,
    }).returning();
    await tx.insert(analyticsLogsTable).values({ ownerId: req.workspaceId, message: `${input.demo ? "Demo" : "Media"} batch queued with ${input.clipCount} clips.` });
    return row;
  });
  if (!created) { res.status(429).json({ error: "Two batches are already queued. Wait for one to finish." }); return; }
  res.status(201).json(CreateProjectResponse.parse(jsonDates(created)));
});
router.get("/projects/:id", async (req, res): Promise<void> => {
  const parsed = GetProjectParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid batch ID." }); return; }
  const [row] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, parsed.data.id), eq(projectsTable.ownerId, req.workspaceId)));
  if (!row) { res.status(404).json({ error: "Batch not found." }); return; }
  res.json(GetProjectResponse.parse(jsonDates(row)));
});
router.delete("/projects/:id", async (req, res): Promise<void> => {
  const parsed = DeleteProjectParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid batch ID." }); return; }
  const [row] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, parsed.data.id), eq(projectsTable.ownerId, req.workspaceId)));
  if (!row) { res.status(404).json({ error: "Batch not found." }); return; }
  if (["queued", "processing"].includes(row.status)) { res.status(409).json({ error: "Wait for this batch to finish before deleting it." }); return; }
  await db.delete(projectsTable).where(eq(projectsTable.id, row.id));
  res.sendStatus(204);
});
router.get("/clips", async (req, res): Promise<void> => {
  res.json(ListClipsResponse.parse((await db.select().from(generatedClipsTable).where(eq(generatedClipsTable.ownerId, req.workspaceId)).orderBy(desc(generatedClipsTable.id))).map(jsonDates)));
});
router.patch("/clips/:id", async (req, res): Promise<void> => {
  const params = UpdateClipParams.safeParse(req.params);
  const parsed = UpdateClipBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid clip changes." }); return; }
  if (parsed.data.campaignId) {
    const [campaign] = await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, parsed.data.campaignId), eq(campaignsTable.ownerId, req.workspaceId)));
    if (!campaign) { res.status(400).json({ error: "Campaign not found." }); return; }
  }
  const [row] = await db.update(generatedClipsTable).set(parsed.data).where(and(eq(generatedClipsTable.id, params.data.id), eq(generatedClipsTable.ownerId, req.workspaceId))).returning();
  if (!row) { res.status(404).json({ error: "Clip not found." }); return; }
  res.json(UpdateClipResponse.parse(jsonDates(row)));
});
router.delete("/clips/:id", async (req, res): Promise<void> => {
  const parsed = DeleteClipParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid clip ID." }); return; }
  const [row] = await db.delete(generatedClipsTable).where(and(eq(generatedClipsTable.id, parsed.data.id), eq(generatedClipsTable.ownerId, req.workspaceId))).returning();
  if (!row) { res.status(404).json({ error: "Clip not found." }); return; }
  res.sendStatus(204);
});
router.post("/exports", async (req, res): Promise<void> => {
  const parsed = CreateExportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose 1–20 clips to export." }); return; }
  const clips = await db.select().from(generatedClipsTable).where(and(inArray(generatedClipsTable.id, parsed.data.clipIds), eq(generatedClipsTable.ownerId, req.workspaceId)));
  if (clips.length !== new Set(parsed.data.clipIds).size) { res.status(404).json({ error: "One or more selected clips are not available." }); return; }
  const result = await buildExport(clips, req.workspaceId);
  res.json(CreateExportResponse.parse(result));
});
export default router;
