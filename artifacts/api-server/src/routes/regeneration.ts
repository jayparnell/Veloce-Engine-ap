import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db, generatedClipsTable as clips, autopilotJobsTable as jobs, autopilotAdmissionsTable as admissions } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { RegenerateClipParams, RegenerateClipResponse } from "@workspace/api-zod";
import { renderInfo, publicClip, outdated, snapshot } from "../pipeline/render-state";
import { autopilotUsage } from "../lib/autopilotQuota";

const router: IRouter = Router();
router.post("/clips/:id/regenerate", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Sign in to regenerate videos." }); return; }
  const params = RegenerateClipParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid clip ID." }); return; }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.workspaceId}))`);
    const [clip] = await tx.select().from(clips).where(and(eq(clips.id, params.data.id), eq(clips.ownerId, req.workspaceId))).for("update");
    if (!clip) return { code: 404, error: "Clip not found." };
    const [previous] = clip.regenerationJobId ? await tx.select().from(jobs).where(eq(jobs.id, clip.regenerationJobId)) : [];
    // Resume failed/uncertain work through the existing explicit job controls, never launch a second paid request.
    if (previous && previous.status !== "completed") return { code: 409, error: "This clip already has a regeneration job. Open Autopilot to view progress, retry or cancel it." };
    const info = await renderInfo(clip);
    if (clip.demo || !info || !clip.voiceoverObjectPath) return { code: 409, error: "This historical clip has no retained render inputs. It remains playable; create a new source batch to enable regeneration." };
    if (!outdated(clip, info)) return { code: 409, error: "Save changes before regenerating this version." };
    if (!clip.script.trim()) return { code: 409, error: "Save a non-empty narration before regenerating." };
    const usage = await tx.execute(autopilotUsage(req.workspaceId));
    if (Number(usage.rows[0]?.active) >= 10 || Number(usage.rows[0]?.daily) >= 20) return { code: 429, error: "Workspace job quota reached. Wait before regenerating." };
    const requestKey = `regenerate:${clip.id}:${randomUUID()}`;
    const [job] = await tx.insert(jobs).values({
      ownerId: clip.ownerId, projectId: clip.projectId, originalClipId: clip.id, language: clip.language,
      requestKey, inputHash: requestKey, checkpoint: { regeneration: {
        clipId: clip.id, version: info.version + 1, snapshot: snapshot(clip), recipe: info.recipe,
        previousScript: info.snapshot.script, voicePath: clip.voiceoverObjectPath, captionsPath: clip.captionsObjectPath,
      } },
      notice: "Explicit editor regeneration. Previous playable version is preserved until replacement files pass checks. AI uses your direct OpenAI key, with at most two retries three seconds apart.",
    }).returning();
    await tx.insert(admissions).values({ ownerId: clip.ownerId, projectId: clip.projectId, jobId: job!.id, requestKey, inputHash: requestKey });
    const [updated] = await tx.update(clips).set({ renderInfo: info, regenerationJobId: job!.id }).where(eq(clips.id, clip.id)).returning();
    return { code: 202, clip: updated! };
  });
  if (!result.clip) { res.status(result.code).json({ error: result.error }); return; }
  res.status(202).json(RegenerateClipResponse.parse(await publicClip(result.clip)));
});
export default router;
