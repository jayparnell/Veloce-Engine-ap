import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import type { Clip } from "@workspace/db";
import { ownedFile, storeBytes } from "../lib/mediaStorage";
import { renderInfo, snapshot, outdated } from "./render-state";

export async function buildExport(clips: Clip[], owner: string, storage = { ownedFile, storeBytes }) {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const complete = new Promise<Buffer>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 500 * 1024 * 1024) { archive.abort(); reject(new Error("Export is too large. Export fewer clips.")); return; }
      chunks.push(chunk);
    });
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);
    archive.on("error", reject);
  });
  // Mark stream failures handled even while asynchronous storage lookups run.
  void complete.catch(() => {});
  archive.pipe(output);
  let includesVideo = false;
  archive.append("Veloce Engine export\n\nDemo clips have metadata only. Real renders are 1080x1920 at 60fps.\nOriginality/reach scores are heuristic editing guidance, not compliance or monetization guarantees.\nReview source permissions, music rights, sponsorship disclosures and platform policies before uploading.\nSaving edits does not render video. Use Regenerate saved edits in the Vault. Exports use the last successful rendered version and matching assets/copy. Newer saved edits are included separately in saved-edits.json.\nHistorical clips without a retained snapshot have unverified metadata; regenerate from a new source batch to establish a matching version.\n", { name: "READ-ME.txt" });
  for (const clip of clips) {
    const folder = `clip-${clip.id}`;
    const info = await renderInfo(clip);
    const copy = info?.snapshot ?? snapshot(clip);
    if (outdated(clip, info)) archive.append(JSON.stringify(snapshot(clip), null, 2), { name: `${folder}/saved-edits.json` });
    archive.append(JSON.stringify({
      ...copy, renderVersion: info?.version ?? (clip.objectPath ? 1 : 0), metadataVerified: !!info,
      language: clip.language, originalClipId: clip.originalClipId,
      demo: clip.demo,
      heuristicScore: clip.score, reviewRequired: true,
      captionTiming: info?.captionTiming === "asr-word" ? "Word-level ASR timestamps from the fitted narration, preserved to milliseconds in SRT. Recognition and alignment require review."
        : "Historical individual-word timing estimated from the narration speech envelope; regenerate to upgrade and review before publishing.",
      platforms: clip.platforms.map((platform) => ({
        platform,
        title: platform === "YouTube Shorts" ? copy.title.slice(0, 90) + " #Shorts" : copy.title,
        description: `${copy.hook}\n${copy.hashtags}`,
        pinnedComment: copy.pinnedComment,
      })),
    }, null, 2), { name: `${folder}/metadata.json` });
    const publishingCopy = `Title: ${copy.title}\n\nHook: ${copy.hook}\n\nHashtags: ${copy.hashtags}\n\nPinned comment:\n${copy.pinnedComment}\n\nNarration:\n${copy.script}`;
    archive.append(publishingCopy, { name: `${folder}/copy.txt` });
    archive.append(publishingCopy, { name: `${folder}/captions.txt` });
    if (clip.captionsObjectPath) {
      const captions = await storage.ownedFile(clip.captionsObjectPath, owner);
      archive.append(captions.createReadStream(), { name: `${folder}/captions.srt` });
    }
    if (clip.voiceoverObjectPath) {
      const voice = await storage.ownedFile(clip.voiceoverObjectPath, owner);
      archive.append(voice.createReadStream(), { name: `${folder}/voiceover.mp3` });
    }
    if (clip.objectPath && !clip.demo) {
      const file = await storage.ownedFile(clip.objectPath, owner);
      archive.append(file.createReadStream(), { name: `${folder}/video.mp4` });
      includesVideo = true;
    }
  }
  await archive.finalize();
  const objectPath = await storage.storeBytes(await complete, owner, "application/zip");
  return { downloadUrl: `/api/storage${objectPath}`, filename: "veloce-export.zip", includesVideo, message: includesVideo ? "Export package includes rendered MP4 files and platform metadata. Review before publishing." : "Demo export: metadata and publishing copy only. No rendered video is included." };
}
