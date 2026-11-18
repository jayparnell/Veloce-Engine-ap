import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./process";
import { transcribeWords, type Word } from "./word-transcription";
import { JobContext } from "./job-context";
import { ownedFile, storeLocalFile } from "../lib/mediaStorage";

export function srtTimestamp(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
export function wordSrt(words: Word[]) {
  return words.map((w, i) => `${i + 1}\n${srtTimestamp(w.start)} --> ${srtTimestamp(w.end)}\n${w.text.replace(/[\r\n]+/g, " ")}`).join("\n\n") + "\n";
}
/** Fit before ASR, so caption boundaries describe the exact audio burned into the video. */
export async function alignVoice(voiceFile: string, duration: number, dir: string, ctx?: JobContext, key = "captions") {
  const owner = ctx?.job.ownerId;
  const saved = ctx?.job.checkpoint[`aligned:${key}`] as { voice: string; captions: string } | undefined;
  const captions = join(dir, `${key.replace(/[^a-z0-9_-]/gi, "_")}.srt`);
  if (saved && owner) {
    await (await ownedFile(saved.voice, owner)).download({ destination: voiceFile });
    await (await ownedFile(saved.captions, owner)).download({ destination: captions });
    return captions;
  }
  const info = JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-of", "json", voiceFile]));
  const length = Number(info.format.duration);
  if (!Number.isFinite(length) || length <= 0) throw new Error("Invalid narration duration.");
  let fitted = length;
  if (length > duration) {
    const factor = length / Math.max(1, duration - .25);
    if (factor > 1.5) throw new Error("Voiceover is too long for this clip; use shorter commentary.");
    const file = `${voiceFile}.fitted.mp3`;
    await command("ffmpeg", ["-v", "error", "-y", "-i", voiceFile, "-af", `atempo=${factor.toFixed(6)}`, "-b:a", "128k", file]);
    await writeFile(voiceFile, await readFile(file));
    fitted = Number(JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-of", "json", voiceFile])).format.duration);
  }
  const transcript = await transcribeWords(voiceFile, Math.min(fitted, duration), ctx, `align:${key}`);
  await writeFile(captions, wordSrt(transcript.words));
  if (owner && ctx) {
    const assets = { voice: await storeLocalFile(voiceFile, owner, "audio/mpeg"), captions: await storeLocalFile(captions, owner, "text/plain") };
    await ctx.save(`aligned:${key}`, assets);
  }
  return captions;
}
