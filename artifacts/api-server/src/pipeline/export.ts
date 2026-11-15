import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import type { Clip } from "@workspace/db";
import { ownedFile, storeBytes } from "../lib/mediaStorage";

export async function buildExport(clips: Clip[], owner: string) {
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
  archive.pipe(output);
  let includesVideo = false;
  archive.append("Veloce Engine export\n\nDemo clips have metadata only. Real renders are 1080x1920 at 60fps.\nOriginality/reach scores are heuristic editing guidance, not compliance or monetization guarantees.\nReview source permissions, music rights, sponsorship disclosures and platform policies before uploading.\nEditor changes update metadata and preview preferences; existing MP4 files are not re-rendered by saving metadata.\n", { name: "READ-ME.txt" });
  for (const clip of clips) {
    const folder = `clip-${clip.id}`;
    archive.append(JSON.stringify({
      title: clip.title, hook: clip.hook, script: clip.script, hashtags: clip.hashtags,
      pinnedComment: clip.pinnedComment, demo: clip.demo,
      heuristicScore: clip.score, reviewRequired: true,
      platforms: clip.platforms.map((platform) => ({
        platform,
        title: platform === "YouTube Shorts" ? clip.title.slice(0, 90) + " #Shorts" : clip.title,
        description: `${clip.hook}\n${clip.hashtags}`,
        pinnedComment: clip.pinnedComment,
      })),
    }, null, 2), { name: `${folder}/metadata.json` });
    archive.append(`${clip.title}\n\n${clip.hook}\n\n${clip.hashtags}\n\nPinned comment:\n${clip.pinnedComment}`, { name: `${folder}/copy.txt` });
    if (clip.objectPath && !clip.demo) {
      const file = await ownedFile(clip.objectPath, owner);
      archive.append(file.createReadStream(), { name: `${folder}/video.mp4` });
      includesVideo = true;
    }
  }
  await archive.finalize();
  const objectPath = await storeBytes(await complete, owner, "application/zip");
  return { downloadUrl: `/api/storage${objectPath}`, filename: "veloce-export.zip", includesVideo, message: includesVideo ? "Export package includes rendered MP4 files and platform metadata. Review before publishing." : "Demo export: metadata and publishing copy only. No rendered video is included." };
}
