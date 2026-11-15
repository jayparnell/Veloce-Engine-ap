import { Router, type IRouter } from "express";
import { db, campaignsTable, generatedClipsTable, projectsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { CreateCampaignBody, UpdateCampaignBody, UpdateCampaignParams, DeleteCampaignParams, ListCampaignsResponse, CreateCampaignResponse, UpdateCampaignResponse } from "@workspace/api-zod";
import { finalizeUpload } from "../lib/uploads";
import { ownedFile } from "../lib/mediaStorage";

const router: IRouter = Router();
function campaignData<T extends { cpm: number; views: number; budget: number; createdAt: Date; audioPath: string | null; watermarkPath: string | null }>(row: T) {
  return { ...row, audioPath: row.audioPath ?? undefined, watermarkPath: row.watermarkPath ?? undefined, payout: Math.round(Math.min(row.budget, row.views / 1000 * row.cpm) * 100) / 100, createdAt: row.createdAt.toISOString() };
}
async function validateAssets(data: { affiliateUrl: string; audioPath?: string; watermarkPath?: string }, owner: string) {
  if (data.affiliateUrl) {
    const url = new URL(data.affiliateUrl);
    if (url.protocol !== "https:") throw new Error("Affiliate URLs must use HTTPS.");
  }
  for (const path of [data.audioPath, data.watermarkPath].filter(Boolean) as string[]) {
    await finalizeUpload(path, owner);
    await ownedFile(path, owner);
  }
}
router.get("/campaigns", async (req, res): Promise<void> => {
  const rows = await db.select().from(campaignsTable).where(eq(campaignsTable.ownerId, req.workspaceId)).orderBy(desc(campaignsTable.id));
  res.json(ListCampaignsResponse.parse(rows.map(campaignData)));
});
router.post("/campaigns", async (req, res): Promise<void> => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a name, brand, nonnegative CPM, budget and valid campaign status." }); return; }
  try { await validateAssets(parsed.data, req.workspaceId); } catch { res.status(400).json({ error: "Use an HTTPS affiliate link and media uploaded to your account." }); return; }
  const [row] = await db.insert(campaignsTable).values({ ...parsed.data, ownerId: req.workspaceId }).returning();
  res.status(201).json(CreateCampaignResponse.parse(campaignData(row!)));
});
router.patch("/campaigns/:id", async (req, res): Promise<void> => {
  const params = UpdateCampaignParams.safeParse(req.params);
  const parsed = UpdateCampaignBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid campaign details." }); return; }
  try { await validateAssets(parsed.data, req.workspaceId); } catch { res.status(400).json({ error: "Use an HTTPS affiliate link and media uploaded to your account." }); return; }
  const [row] = await db.update(campaignsTable).set(parsed.data).where(and(eq(campaignsTable.id, params.data.id), eq(campaignsTable.ownerId, req.workspaceId))).returning();
  if (!row) { res.status(404).json({ error: "Campaign not found." }); return; }
  res.json(UpdateCampaignResponse.parse(campaignData(row)));
});
router.delete("/campaigns/:id", async (req, res): Promise<void> => {
  const parsed = DeleteCampaignParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid campaign ID." }); return; }
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx.delete(campaignsTable).where(and(eq(campaignsTable.id, parsed.data.id), eq(campaignsTable.ownerId, req.workspaceId))).returning();
    if (!row) return false;
    await tx.update(generatedClipsTable).set({ campaignId: null }).where(and(eq(generatedClipsTable.campaignId, row.id), eq(generatedClipsTable.ownerId, req.workspaceId)));
    await tx.update(projectsTable).set({ campaignId: null }).where(and(eq(projectsTable.campaignId, row.id), eq(projectsTable.ownerId, req.workspaceId)));
    return true;
  });
  if (!removed) { res.status(404).json({ error: "Campaign not found." }); return; }
  res.sendStatus(204);
});
export default router;
