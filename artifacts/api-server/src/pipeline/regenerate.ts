import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, generatedClipsTable as clips, type RenderInfo, type PoolClient } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { JobContext } from "./job-context";
import { command } from "./process";
import { synthesizeVoiceover } from "./audio";
import { ownedFile, storeLocalFile } from "../lib/mediaStorage";
import { workspaceRoot, mediaPython, mediaRenderer } from "./paths";
import { commitOutput } from "../lib/render-budget";
import { alignVoice } from "./caption-alignment";

export type Regeneration = RenderInfo & {
  clipId: number; previousScript: string; voicePath: string; captionsPath: string | null;
};
type Assets = { video: string; voice: string; captions: string; poster: string; duration: number; info: RenderInfo };
const storage = {
  download: async (path: string, destination: string, owner: string) => {
    await (await ownedFile(path, owner)).download({ destination });
  },
  persist: storeLocalFile,
  synthesize: synthesizeVoiceover,
  align: alignVoice,
  render: async (path: string) => { await command(mediaPython, [mediaRenderer, "render", path], 900000); },
};

/** All bytes are immutable; only the final fenced transaction replaces the playable asset set. */
export async function runRegeneration(ctx: JobContext, connection: PoolClient, services = storage) {
  const request = ctx.job.checkpoint.regeneration as Regeneration;
  const owner = ctx.job.ownerId;
  const [clip] = await db.select().from(clips).where(and(eq(clips.id, request.clipId), eq(clips.ownerId, owner)));
  if (!clip || clip.regenerationJobId !== ctx.job.id) throw new Error("Regeneration no longer belongs to this clip.");
  if (clip.renderInfo?.version === request.version) return; // Recovered after output commit.
  const root = join(workspaceRoot, "generated-artifacts/media-work");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `regenerate-${ctx.job.id}-`));
  try {
    let assets = ctx.job.checkpoint.regeneratedAssets as Assets | undefined;
    if (!assets) {
      const hydrate = async (path: string, name: string) => {
        const destination = join(dir, name);
        await services.download(path, destination, owner);
        return destination;
      };
      const source = await hydrate(request.recipe.source.objectPath, "source.mp4");
      await ctx.update({ stage: "regenerating narration", progress: 15 });
      const changed = request.snapshot.script !== request.previousScript;
      const voice = changed ? await ctx.ai("editor-voice", async () => {
        const result = await services.synthesize(request.snapshot.script, ctx.job.language, ctx.abort.signal);
        const path = join(dir, "new-voice.mp3");
        await writeFile(path, result.bytes);
        return { objectPath: await services.persist(path, owner, "audio/mpeg"), transcript: result.transcript };
      }) : { objectPath: request.voicePath, transcript: request.previousScript };
      const voiceFile = await hydrate(String(voice.objectPath), "voice.mp3");
      const captionsInput = !changed && request.captionsPath && clip.renderInfo?.captionTiming === "asr-word" ? await hydrate(request.captionsPath, "previous.srt") :
        await (services.align ?? alignVoice)(voiceFile, request.recipe.segments.reduce((n, s) => n + Math.min(55, s.end - s.start), 0), dir, ctx, "editor");
      const sponsorAudio = request.recipe.sponsorAudio ? await hydrate(request.recipe.sponsorAudio, "sponsor") : undefined;
      const watermark = request.recipe.watermark ? await hydrate(request.recipe.watermark, "watermark") : undefined;
      const output = join(dir, "video.mp4"), poster = join(dir, "poster.jpg"), captionsOutput = join(dir, "captions.srt");
      // Story's opening chapter is the clip headline. Later chapters retain their source-specific labels.
      const recipe = request.recipe.mode === "story" ? { ...request.recipe,
        segments: request.recipe.segments.map((segment, index) => index === 0 ? { ...segment, title: request.snapshot.title } : segment),
      } : request.recipe;
      const info: RenderInfo = { version: request.version, captionTiming: "asr-word", recipe, snapshot: { ...request.snapshot, script: String(voice.transcript) } };
      const config = { ...recipe, ...info.snapshot, source, voiceFile, output, poster, captionsOutput, captionsInput, requireWordTiming: true, sponsorAudio, watermark };
      const path = join(dir, "render.json");
      await writeFile(path, JSON.stringify(config));
      await ctx.update({ stage: "waiting for renderer", progress: 35 });
      for (;;) {
        await ctx.check();
        const lock = await connection.query("SELECT pg_try_advisory_lock(74002,0) AS acquired");
        if (lock.rows[0]?.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      try {
        await ctx.update({ stage: "rendering saved edits", progress: 50 });
        await services.render(path);
      } finally { await connection.query("SELECT pg_advisory_unlock(74002,0)"); }
      const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", output]));
      const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      const duration = Number(probe.format.duration);
      const expected = request.recipe.segments.reduce((n, s) => n + Math.min(55, s.end - s.start), 0) + (request.recipe.mode === "bounty" ? 3 : 0);
      if (video?.width !== 1080 || video.height !== 1920 || video.r_frame_rate !== "60/1"
        || !probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")
        || !Number.isFinite(duration) || Math.abs(duration - expected) > .5) throw new Error("Replacement failed video/audio technical checks. Previous version is unchanged.");
      await ctx.update({ stage: "persisting verified replacement", progress: 90 });
      assets = {
        video: await services.persist(output, owner, "video/mp4"),
        voice: await services.persist(voiceFile, owner, "audio/mpeg"),
        captions: await services.persist(captionsOutput, owner, "text/plain"),
        poster: await services.persist(poster, owner, "image/jpeg"), duration, info,
      };
      await ctx.save("regeneratedAssets", assets);
    }
    const ready = assets;
    await commitOutput(owner, ctx.job.id, 0, ctx.token, async (c) => {
      const [updated] = await drizzle(c).update(clips).set({
        objectPath: ready.video, voiceoverObjectPath: ready.voice, captionsObjectPath: ready.captions,
        videoUrl: `/api/storage${ready.video}`, thumbnail: `/api/storage${ready.poster}`, duration: ready.duration, renderInfo: ready.info,
        script: sql`CASE WHEN ${clips.script} = ${request.snapshot.script} THEN ${ready.info.snapshot.script} ELSE ${clips.script} END`,
      }).where(and(eq(clips.id, request.clipId), eq(clips.ownerId, owner), eq(clips.regenerationJobId, ctx.job.id))).returning();
      if (!updated) throw new Error("Clip was removed or superseded before replacement.");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
