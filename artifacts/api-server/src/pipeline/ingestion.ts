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
    ...(!fallback ? ["--extractor-args", "youtube:player_client=android,web"] : []),
    "-f", fallback
      ? "best[height<=720]/bestvideo[height<=720]+bestaudio/best[height<=1080]"
      : "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--merge-output-format", "mp4", "--remux-video", "mp4",
    "-o", destination, "--", sourceUrl,
  ];
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
