/** Completed VODs only: full source, never a silent first-N-seconds excerpt. */
export const MAX_SOURCE_SECONDS = 3600;
export const MAX_REMOTE_BYTES = 2 * 1024 ** 3;

export class SourceIngestionError extends Error {}

export function sourceToolError(stderr: string) {
  // Preserve the actual provider error, not credential-bearing URLs or local paths.
  const lines = stderr.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((line) => /ERROR:|does not pass filter|rejected|larger than max-filesize/i.test(line));
  return (lines.join("\n") || stderr.trim() || "The provider returned no downloadable video.")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[provider URL]")
    .replace(/(?:\/home\/|\/tmp\/)[^\s"'<>]+/g, "[temporary file]")
    .slice(-1600);
}

export function vodArguments(sourceUrl: string, destination: string, fallback = false) {
  return [
    "--no-playlist", "--no-warnings", "--socket-timeout", "30",
    "--retries", "2", "--fragment-retries", "2", "--concurrent-fragments", "4",
    "--max-filesize", "2G", "--break-on-reject",
    "--match-filter", `!is_live & duration <= ${MAX_SOURCE_SECONDS}`,
    ...(!fallback ? ["--extractor-args", "youtube:player_client=android,ios,web"] : []),
    "-f", fallback
      ? "best[height<=720]/bestvideo[height<=720]+bestaudio/best[height<=1080]"
      : "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
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
export function rangeArguments(url: string, destination: string, start: number, end: number, fallback = false, audioOnly = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > (audioOnly ? 600 : 45)) throw new SourceIngestionError("Invalid bounded source time range.");
  return [...extractionBase,
    ...(!fallback ? ["--extractor-args", "youtube:player_client=android,ios,web"] : []),
    "--max-filesize", audioOnly ? "80M" : "250M", "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
    "--force-keyframes-at-cuts", "--concurrent-fragments", "2",
    "-f", audioOnly ? "bestaudio/best" : fallback ? "best[height<=720]/bestvideo[height<=720]+bestaudio" : "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    ...(audioOnly ? ["-x", "--audio-format", "mp3"] : ["--merge-output-format", "mp4", "--remux-video", "mp4"]),
    "-o", destination, "--", url];
}
export async function ingestRange(url: string, destination: string, start: number, end: number, execute: Execute, audioOnly = false) {
  try { await execute("yt-dlp", rangeArguments(url, destination, start, end, false, audioOnly), 300000); }
  catch (first) {
    // Alternate supported extractor profile only, never cookies/proxies/access-control bypass.
    if (/private|geo.block|DRM|sign in|confirm.*bot|not available.*country/i.test(String(first))) throw first;
    try { await execute("yt-dlp", rangeArguments(url, destination, start, end, true, audioOnly), 300000); }
    catch (last) { throw new SourceIngestionError(`Selected-range retrieval failed: ${last instanceof Error ? last.message : "Provider rejected retrieval"}. Upload an authorized MP4 instead. No full-VOD fallback was made.`); }
  }
}

type Execute = (executable: string, args: string[], timeout?: number) => Promise<string>;
export async function ingestVod(sourceUrl: string, destination: string, execute: Execute) {
  try {
    await execute("yt-dlp", vodArguments(sourceUrl, destination), 15 * 60 * 1000);
  } catch (first) {
    // Retry extraction with the default client and a smaller full-length stream.
    try {
      await execute("yt-dlp", vodArguments(sourceUrl, destination, true), 15 * 60 * 1000);
    } catch (last) {
      const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new SourceIngestionError(`Source ingestion failed: ${describe(last)}\nFirst attempt: ${describe(first)}\nUse a completed VOD up to 60 minutes, or Upload an authorized MP4 instead.`);
    }
  }
}
