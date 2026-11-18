import { redactError } from "../lib/failure-policy";

/** Completed VODs only: full source, never a silent first-N-seconds excerpt. */
export const MAX_SOURCE_SECONDS = 240 * 60;
export const MIN_CLIP_SECONDS = 15;
export const MAX_CLIP_SECONDS = 55;
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

export function vodArguments(sourceUrl: string, destination: string, fallback = false, botRetry = false) {
  return [
    "--no-playlist", "--no-warnings", "--socket-timeout", "30",
    "--ignore-config", "--no-plugin-dirs", "--retries", "2", "--fragment-retries", "2", "--concurrent-fragments", "1",
    "--no-continue", "--force-overwrites",
    "--max-filesize", "2G", "--break-on-reject",
    "--match-filter", `!is_live & duration <= ${MAX_SOURCE_SECONDS}`,
    "--force-ipv4", "--js-runtimes", `node:${process.execPath}`,
    ...(fallback && botRetry ? ["--no-check-certificates", "--geo-bypass"] : []),
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
    "--merge-output-format", "mp4", "--remux-video", "mp4",
    // Let the downloaded container keep its real extension until remuxing.
    // A forced .mp4 download name can yield .mp4.mp4 for single WebM streams.
    "-o", destination.replace(/\.mp4$/i, ".%(ext)s"), "--", sourceUrl,
  ];
}

export const extractionBase = [
  "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings",
  "--socket-timeout", "15", "--retries", "1", "--fragment-retries", "1",
  "--use-extractors", "youtube.*,twitch.*,kick.*",
];
export function metadataArguments(url: string, fallback = false, botRetry = false) {
  return [...extractionBase, "--force-ipv4", "--js-runtimes", `node:${process.execPath}`,
    ...(fallback && botRetry ? ["--no-check-certificates", "--geo-bypass"] : []),
    "--skip-download", "--dump-single-json", "--", url];
}
export function sliceArguments(source: string, destination: string, start: number, end: number, audioOnly = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > (audioOnly ? 600 : MAX_CLIP_SECONDS)) throw new SourceIngestionError("Invalid bounded source time range.");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(start), "-i", source, "-t", String(end - start),
    ...(audioOnly ? ["-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-c:a", "aac", "-movflags", "+faststart"]), destination];
}

export type Execute = (executable: string, args: string[], timeout?: number) => Promise<string>;
export function isBotCheck(error: unknown) {
  return /confirm.*(?:not a bot|bot)|sign.in.*bot|bot check|automated (?:requests|traffic)/i.test(String(error));
}
export async function ingestVod(sourceUrl: string, destination: string, execute: Execute) {
  try {
    await execute("yt-dlp", vodArguments(sourceUrl, destination), 15 * 60 * 1000);
  } catch (first) {
    if (isIngestionCancellation(first) || (!isBotCheck(first) && /private|geo.block|DRM|sign in|not available.*country/i.test(String(first)))) throw first;
    // A fresh subprocess reconnects to the unmodified rotating proxy endpoint.
    // TLS verification is disabled only on the explicitly requested bot-check retry.
    try {
      await execute("yt-dlp", vodArguments(sourceUrl, destination, true, isBotCheck(first)), 15 * 60 * 1000);
    } catch (last) {
      if (isIngestionCancellation(last)) throw last;
      const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new SourceIngestionError(`Full-source download failed: ${describe(last)}\nFirst attempt: ${describe(first)}\nRetry starts a fresh full-source download using the configured proxy.`);
    }
  }
}
