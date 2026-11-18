import { metadataArguments, SourceIngestionError, MAX_SOURCE_SECONDS, MAX_REMOTE_BYTES, isIngestionCancellation } from "./ingestion";
import { withCaptionResponse } from "./youtube-network";

export type Segment = { start: number; end: number; text: string };
/** Add real surrounding context to a short proposed window; never trim its evidence or exceed coverage. */
export function boundedMoment(start: number, end: number, coverage: number) {
  if (![start, end, coverage].every(Number.isFinite) || start < 0 || end <= start || end > coverage + .01 || end - start > 45 || coverage < 30) return null;
  if (end - start < 30) {
    start = Math.max(0, Math.min(start, end - 30));
    end = Math.min(coverage, Math.max(end, start + 30));
  }
  return { start, end };
}
type Subtitle = { ext: string; url: string };
export type SourceMetadata = { title: string; duration: number; is_live?: boolean; filesize?: number; filesize_approx?: number; subtitles?: Record<string, Subtitle[]>; automatic_captions?: Record<string, Subtitle[]> };
type Execute = (exe: string, args: string[], timeout?: number) => Promise<string>;
export async function getSourceMetadata(url: string, execute: Execute): Promise<SourceMetadata> {
  let raw: string;
  try { raw = await execute("yt-dlp", metadataArguments(url), 45000); }
  catch (first) {
    if (isIngestionCancellation(first)) throw first;
    if (/private|geo.block|DRM|confirm.*bot/i.test(String(first))) throw first;
    raw = await execute("yt-dlp", metadataArguments(url, true), 45000);
  }
  const data = JSON.parse(raw) as SourceMetadata;
  if (!Number.isFinite(data.duration) || data.duration < 30 || data.duration > MAX_SOURCE_SECONDS || data.is_live) throw new SourceIngestionError("Source must be a completed 30-second to 60-minute VOD.");
  if (Number(data.filesize ?? data.filesize_approx ?? 0) > MAX_REMOTE_BYTES) throw new SourceIngestionError("Source exceeds the 2 GB provider-reported size limit. Upload a smaller authorized MP4.");
  return { title: String(data.title ?? "Authorized source").slice(0, 160), duration: data.duration, subtitles: data.subtitles, automatic_captions: data.automatic_captions };
}
export function parseJson3(value: unknown, duration: number): Segment[] {
  const events = (value as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] })?.events;
  if (!Array.isArray(events)) return [];
  const result: Segment[] = [];
  for (const event of events) {
    const start = Number(event.tStartMs) / 1000, end = Math.min(duration, start + Number(event.dDurationMs) / 1000);
    const text = (event.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) result.push({ start, end, text: text.slice(0, 3000) });
  }
  return result.sort((a, b) => a.start - b.start).slice(0, 12000);
}
export function parseTimedText(body: string, duration: number): Segment[] {
  const seconds = (s: string) => s.replace(",", ".").split(":").reduce((sum, n) => sum * 60 + Number(n), 0);
  const segments: Segment[] = [];
  for (const block of body.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(line));
    if (index < 0) continue;
    const match = lines[index]!.match(/^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/)!;
    const start = seconds(match[1]!), end = Math.min(duration, seconds(match[2]!));
    const text = lines.slice(index + 1).join(" ").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < duration && end > start && text) segments.push({ start, end, text: text.slice(0, 3000) });
  }
  return segments.sort((a, b) => a.start - b.start).slice(0, 12000);
}
export async function accessibleCaptions(meta: SourceMetadata, consumeResponse = withCaptionResponse): Promise<Segment[]> {
  const tracks = { ...meta.automatic_captions, ...meta.subtitles };
  const keys = Object.keys(tracks).sort((a, b) => Number(!a.startsWith("en")) - Number(!b.startsWith("en")));
  for (const key of keys.slice(0, 3)) {
    const track = tracks[key]?.find((t) => ["json3", "vtt", "srt"].includes(t.ext));
    if (!track) continue;
    try {
      const url = new URL(track.url), host = url.hostname;
      if (url.protocol !== "https:" || url.username || url.password || url.port || !["youtube.com", "googlevideo.com", "twitch.tv", "ttvnw.net", "kick.com"].some((h) => host === h || host.endsWith(`.${h}`))) continue;
      const segments = await consumeResponse(url, async response => {
        if (!response.ok) return [];
        // Enforce the byte limit during transfer, not just from an optional length header.
        if (Number(response.headers.get("content-length")) > 4_000_000) return [];
        const reader = response.body?.getReader();
        if (!reader) return [];
        let text = "", bytes = 0;
        const decoder = new TextDecoder();
        try {
          for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4_000_000) throw new Error("Caption size limit"); text += decoder.decode(next.value, { stream: true }); }
        } finally { await reader.cancel(); reader.releaseLock(); }
        return track.ext === "json3" ? parseJson3(JSON.parse(text), meta.duration) : parseTimedText(text, meta.duration);
      });
      if (segments.length) return segments;
    } catch { /* Missing/inaccessible captions disclose a bounded audio fallback. */ }
  }
  return [];
}
/** Only remove caption-evidenced filler-only intervals and gaps, bounded to keep >=30s. */
export function retainedRanges(start: number, end: number, transcript: Segment[]) {
  const spans = transcript.filter((s) => s.end > start && s.start < end);
  const cuts: { start: number; end: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (/^(um+|uh+|erm|hmm)[,.!? ]*$/i.test(s.text) && s.end - s.start < 2) cuts.push({ start: Math.max(start, s.start), end: Math.min(end, s.end) });
    const next = spans[i + 1];
    if (next && next.start - s.end > 1) cuts.push({ start: Math.max(start, s.end + .15), end: Math.min(end, next.start - .15) });
  }
  let removed = 0, cursor = start;
  const keep: { start: number; end: number; title: string }[] = [];
  for (const cut of cuts.sort((a, b) => a.start - b.start)) {
    const a = Math.max(cursor, cut.start), length = cut.end - a;
    if (length <= .1 || removed + length > end - start - 30) continue;
    if (a > cursor) keep.push({ start: cursor, end: a, title: "Source" });
    cursor = cut.end; removed += length;
  }
  if (cursor < end) keep.push({ start: cursor, end, title: "Source" });
  return keep;
}
