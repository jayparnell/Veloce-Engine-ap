import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

let cached: { media: boolean; ai: boolean; publishing: boolean; uploads: boolean } | undefined;
let checkedAt = 0;
export function getCapabilities() {
  if (cached && Date.now() - checkedAt < 30000) return cached;
  checkedAt = Date.now();
  // Do not launch Python-based tools on an HTTP request: cold startup can take
  // several seconds and falsely report unavailable tools while blocking the API.
  const hasTool = (tool: string) => (process.env.PATH ?? "").split(delimiter).some((directory) => {
    try { accessSync(join(directory, tool), constants.X_OK); return true; } catch { return false; }
  });
  cached = {
    media: hasTool("ffmpeg") && hasTool("ffprobe") && hasTool("yt-dlp"),
    ai: Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY),
    publishing: false,
    uploads: Boolean(process.env.PRIVATE_OBJECT_DIR && process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID),
  };
  return cached;
}
