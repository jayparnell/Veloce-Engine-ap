import { Router, type IRouter, type Request } from "express";
import { db, publishQueueTable as queue, socialAccountsTable as accounts, generatedClipsTable as clips } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { GetPublishingReviewParams, GetPublishingReviewResponse, ApprovePublishingReviewParams, ApprovePublishingReviewBody } from "@workspace/api-zod";
import { accountToken } from "../publishing/tokens";
import { tiktokCreator } from "../publishing/adapters";

const router: IRouter = Router();
async function load(req: Request, id: number) {
  if (!req.isAuthenticated()) return null;
  const [row] = await db.select({ work: queue, account: accounts, clip: clips }).from(queue)
    .innerJoin(accounts, eq(accounts.id, queue.accountId)).innerJoin(clips, eq(clips.id, queue.clipId))
    .where(and(eq(queue.id, id), eq(queue.ownerId, req.workspaceId), eq(accounts.provider, "tiktok")));
  return row;
}
router.get("/autopilot/publish/:id/review", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const params = GetPublishingReviewParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid publishing entry." }); return; }
  const row = await load(req, params.data.id);
  if (!row) { res.status(404).json({ error: "Publishing entry not found." }); return; }
  try {
    const token = await accountToken(row.account.id), creator = await tiktokCreator({ token: token.access_token, request: fetch });
    res.json(GetPublishingReviewResponse.parse({ title: row.clip.title, caption: `${row.clip.title}\n${row.clip.hashtags}`.slice(0, 2000), videoUrl: row.clip.videoUrl,
      creatorName: creator.creator_nickname ?? row.account.handle, privacyOptions: creator.privacy_level_options ?? [],
      commentDisabled: Boolean(creator.comment_disabled), duetDisabled: Boolean(creator.duet_disabled), stitchDisabled: Boolean(creator.stitch_disabled),
      maxDuration: creator.max_video_post_duration_sec ?? 0,
      canPost: row.account.connected && row.account.autoEnabled && row.account.approved && row.clip.duration <= creator.max_video_post_duration_sec && (creator.privacy_level_options?.length ?? 0) > 0 }));
  } catch { res.status(409).json({ error: "Creator restrictions could not be confirmed. Check authorization, posting scopes and provider approval." }); }
});
router.post("/autopilot/publish/:id/review", async (req, res): Promise<void> => {
  const params = ApprovePublishingReviewParams.safeParse(req.params), input = ApprovePublishingReviewBody.safeParse(req.body);
  if (!params.success || !input.success || !input.data.consent) { res.status(400).json({ error: "Review this video, choose privacy, and confirm Music Usage before approving." }); return; }
  const row = await load(req, params.data.id);
  if (!row) { res.status(404).json({ error: "Publishing entry not found." }); return; }
  if (row.work.status !== "needs_review" || !row.account.connected || !row.account.approved || !row.account.autoEnabled) { res.status(409).json({ error: "This entry cannot be approved in its current state." }); return; }
  try {
    const token = await accountToken(row.account.id), creator = await tiktokCreator({ token: token.access_token, request: fetch });
    if (!creator.privacy_level_options.includes(input.data.privacyLevel) || row.clip.duration > creator.max_video_post_duration_sec) { res.status(409).json({ error: "Privacy or duration is no longer permitted by this creator's account." }); return; }
    if (input.data.brandContent && input.data.privacyLevel !== "PUBLIC_TO_EVERYONE") { res.status(409).json({ error: "Branded partner content requires an explicitly selected public post. Check this account's available privacy options." }); return; }
    const approval = { ...input.data, disclosureReviewed: true, clipId: row.clip.id, objectPath: row.clip.objectPath, caption: `${row.clip.title}\n${row.clip.hashtags}`.slice(0, 2000), approvedAt: new Date().toISOString(), disableComment: creator.comment_disabled || input.data.disableComment, disableDuet: creator.duet_disabled || input.data.disableDuet, disableStitch: creator.stitch_disabled || input.data.disableStitch };
    const [updated] = await db.update(queue).set({ checkpoint: { ...row.work.checkpoint, approval }, status: "scheduled", error: null, retryAt: null })
      .where(and(eq(queue.id, row.work.id), eq(queue.status, "needs_review"))).returning();
    if (!updated) { res.status(409).json({ error: "Publishing state changed. Refresh before approving." }); return; }
    res.json({ message: "This specific video and privacy choice are approved. The running publisher will send it at its next due check." });
  } catch { res.status(409).json({ error: "Could not confirm TikTok approval requirements. Nothing was published." }); }
});
export default router;
