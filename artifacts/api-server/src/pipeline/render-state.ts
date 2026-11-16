import { db, autopilotJobsTable as jobs, aiCheckpointsTable as calls, campaignsTable, type Clip, type RenderInfo, type RenderSnapshot } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export function snapshot(clip: RenderSnapshot): RenderSnapshot {
  const { title, hook, script, hashtags, pinnedComment, captions, pictureInPicture, campaignId } = clip;
  return { title, hook, script, hashtags, pinnedComment, captions, pictureInPicture, campaignId };
}
export function outdated(clip: Clip, info = clip.renderInfo) {
  return !!info && JSON.stringify(snapshot(clip)) !== JSON.stringify(snapshot(info.snapshot));
}
/** Recover pre-editor Autopilot inputs without downloading the source again. */
export async function renderInfo(clip: Clip): Promise<RenderInfo | null> {
  if (clip.renderInfo) return clip.renderInfo;
  if (!clip.jobId || clip.momentIndex == null) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, clip.jobId));
  if (!job || job.ownerId !== clip.ownerId) return null;
  const input = job.checkpoint[`clip:${clip.momentIndex}:input`] as RenderInfo["recipe"] | undefined;
  const moment = (job.checkpoint.moments as RenderSnapshot[] | undefined)?.[clip.momentIndex];
  if (!input?.source?.objectPath || !input.segments?.length || !moment) return null;
  const [voice] = await db.select().from(calls).where(and(eq(calls.jobId, job.id), eq(calls.callKey, `voice:${clip.momentIndex}`)));
  const [campaign] = clip.campaignId ? await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, clip.campaignId), eq(campaignsTable.ownerId, clip.ownerId))) : [];
  // Historical renders always enabled captions and face tracking.
  return { version: 1, recipe: { source: input.source, segments: input.segments, mode: clip.mode, sponsorAudio: campaign?.audioPath ?? undefined },
    snapshot: snapshot({ ...clip, ...moment, script: String(voice?.result?.transcript ?? moment.script),
      captions: true, pictureInPicture: true }) };
}
export async function publicClip(clip: Clip) {
  const info = await renderInfo(clip);
  const [job] = clip.regenerationJobId
    ? await db.select().from(jobs).where(eq(jobs.id, clip.regenerationJobId)) : [];
  return { ...clip, createdAt: clip.createdAt.toISOString(), renderVersion: info?.version ?? (clip.objectPath ? 1 : 0),
    renderOutdated: outdated(clip, info), canRegenerate: !clip.demo && !!info && !!clip.voiceoverObjectPath,
    renderStatus: job?.status ?? null, renderError: job?.error ?? null };
}
