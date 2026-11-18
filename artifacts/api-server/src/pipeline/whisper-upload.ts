import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./process";

// Leave headroom below OpenAI's 25 MB limit for multipart metadata.
export const MAX_WHISPER_BYTES = 24_000_000;
export function assertWhisperSize(bytes: number) {
  if (bytes <= 0) throw new Error("Whisper audio is empty.");
  if (bytes >= MAX_WHISPER_BYTES) throw new Error("Compressed Whisper audio exceeds the 24 MB safe upload limit. Split this recording into smaller segments.");
}
export async function prepareWhisperAudio(input: string) {
  const directory = await mkdtemp(join(tmpdir(), "whisper-upload-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, "audio.mp3");
    await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input,
      "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "64k", path], 120000);
    assertWhisperSize((await stat(path)).size);
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
