import { redactError } from "../lib/failure-policy";

/** Completed VODs only: full source, never a silent first-N-seconds excerpt. */
export const MAX_SOURCE_SECONDS = 3600;
export const MAX_REMOTE_BYTES = 2 * 1024 ** 3;

export class SourceIngestionError extends Error {}
export function isIngestionCancellation(error: unknown) {
  return error instanceof Error && (["AbortError", "JobStoppedError"].includes(error.name) ||
    /processing cancel[lr]ed|processing stopped|worker lease lost/i.test(error.message));
}

export function sourceToolError(stderr: string) {
  // Preserve the actual provider error, not credential-bearing URLs or local paths.
  const lines = stderr.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((line) => /ERROR:|does not pass filter|rejected|larger than max-filesize/i.test(line));
  if (/(?:invalid|malformed|does not look|failed to (?:load|read)).*cookie|cookie.*(?:invalid|malformed|does not look)/i.test(lines.join("\n"))) {
    return "YouTube cookie file could not be read. Check the Netscape-format YOUTUBE_COOKIES secret or clear it; cookie contents were not logged.";
  }
  return redactError(new Error(lines.join("\n") || stderr.trim() || "The provider returned no downloadable video.")).slice(-1600);
}

export function vodArguments(sourceUrl: string, destination: string, fallback = false) {
  return [
    "--no-playlist", "--no-warnings", "--socket-timeout", "30",
    "--ignore-config", "--no-plugin-dirs", "--retries", "2", "--fragment-retries", "2", "--concurrent-fragments", "1",
    "--no-continue", "--force-overwrites",
    "--max-filesize", "2G", "--break-on-reject",
    "--match-filter", `!is_live & duration <= ${MAX_SOURCE_SECONDS}`,
    ...(!fallback ? ["--extractor-args", "youtube:player_client=android,ios,web"] : []),
    "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]",
    "--format-sort", "vcodec:h264",
    "--merge-output-format", "mp4", "--remux-video", "mp4",
    "-o", destination, "--", sourceUrl,
  ];
}

export const extractionBase = [
  "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings",
  "--socket-timeout", "15", "--retries", "1", "--fragment-retries", "1",
  "--use-extractors", "youtube.*,twitch.*,kick.*",
];
export function metadataArguments(url: string, fallback = false) {
  return [...extractionBase, ...(!fallback ? ["--extractor-args", "youtube:player_client=android,ios,web"] : []),
    "--skip-download", "--dump-single-json", "--", url];
}
export function sliceArguments(source: string, destination: string, start: number, end: number, audioOnly = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > (audioOnly ? 600 : 45)) throw new SourceIngestionError("Invalid bounded source time range.");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(start), "-i", source, "-t", String(end - start),
    ...(audioOnly ? ["-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-c:a", "aac", "-movflags", "+faststart"]), destination];
}

export type Execute = (executable: string, args: string[], timeout?: number) => Promise<string>;
export async function ingestVod(sourceUrl: string, destination: string, execute: Execute) {
  try {
    await execute("yt-dlp", vodArguments(sourceUrl, destination), 15 * 60 * 1000);
  } catch (first) {
    if (isIngestionCancellation(first) || /private|geo.block|DRM|sign in|confirm.*bot|not available.*country/i.test(String(first))) throw first;
    // Retry the full stream with the default extractor, never remote time-range requests.
    try {
      await execute("yt-dlp", vodArguments(sourceUrl, destination, true), 15 * 60 * 1000);
    } catch (last) {
      if (isIngestionCancellation(last)) throw last;
      const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new SourceIngestionError(`Full-source download failed: ${describe(last)}\nFirst attempt: ${describe(first)}\nRetry starts a fresh full-source download using the configured job proxy session.`);
    }
  }
}
