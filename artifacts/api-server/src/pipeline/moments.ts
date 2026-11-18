import { z } from "zod";
import { boundedMoment, type Segment } from "./transcript";
import { isIngestionCancellation, MIN_CLIP_SECONDS, MAX_SOURCE_SECONDS, type Execute } from "./ingestion";

export const momentSchema = z.object({
  start: z.number().nonnegative(), end: z.number().positive(), title: z.string().min(1).max(160),
  hook: z.string().min(1).max(200), script: z.string().min(20).max(1200), hashtags: z.string().max(500),
  pinnedComment: z.string().max(500), hookScore: z.number().min(0).max(100), evidence: z.string().min(5).max(600),
});
export type Moment = z.infer<typeof momentSchema>;
const normalize = (s: string) => s.normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

export function hasSpeech(transcript: Segment[]) {
  return transcript.map(s => s.text).join(" ").split(/\s+/).filter(Boolean).length >= 12;
}

/** Reject individual invalid suggestions, not an otherwise usable batch. */
export function groundedMoments(value: unknown, transcript: Segment[], duration: number): Moment[] {
  const items = (value as { moments?: unknown[] } | null)?.moments;
  if (!Array.isArray(items)) return [];
  const coverage = Math.min(duration, transcript.reduce((max, s) => Math.max(max, s.end), 0));
  const result: Moment[] = [];
  for (const item of items) {
    const parsed = momentSchema.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data, window = boundedMoment(m.start, m.end, coverage);
    if (!window) continue;
    const evidence = normalize(transcript.filter(s => s.end > window.start && s.start < window.end).map(s => s.text).join(" "));
    const quote = normalize(m.evidence);
    if (!quote || !evidence.includes(quote) || result.some(r => r.start === window.start && r.end === window.end)) continue;
    result.push({ ...m, ...window });
    if (result.length === 3) break;
  }
  return result;
}

export function fallbackWindows(duration: number, samples = 3) {
  if (!Number.isFinite(duration) || duration < MIN_CLIP_SECONDS || duration > MAX_SOURCE_SECONDS) throw new Error("Source must be 15 seconds to 240 minutes.");
  const length = Math.min(40, duration);
  const count = Math.max(1, Math.min(samples, Math.floor(duration / length)));
  return Array.from({ length: count }, (_, i) => {
    const start = count === 1 ? 0 : (duration - length) * i / (count - 1);
    return { start, end: start + length };
  });
}

/** Sample distributed windows, prefer loud windows, and fall back to spacing on local scan failure/silence. */
export async function fallbackMoments(source: string, duration: number, execute: Execute): Promise<Moment[]> {
  const spaced = fallbackWindows(duration);
  const candidates: { start: number; end: number; energy: number }[] = [];
  let scanFailed = false;
  for (const window of fallbackWindows(duration, 9)) {
    try {
      const output = await execute("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(window.start), "-i", source,
        "-t", String(window.end - window.start), "-vn", "-ac", "1", "-ar", "8000",
        "-af", "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"], 60000);
      const levels = [...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)].map(m => Number(m[1])).filter(Number.isFinite);
      if (levels.length) candidates.push({ ...window, energy: levels.at(-1)! });
    } catch (error) {
      if (isIngestionCancellation(error)) throw error;
      scanFailed = true; break; // A local energy heuristic must never prevent clipping a valid video.
    }
  }
  const ranked: typeof candidates = [];
  for (const w of candidates.sort((a, b) => b.energy - a.energy)) {
    if (ranked.every(r => Math.abs(r.start - w.start) >= (w.end - w.start))) ranked.push(w);
    if (ranked.length === spaced.length) break;
  }
  const windows = !scanFailed && ranked.length === spaced.length ? ranked.sort((a, b) => a.start - b.start) : spaced;
  return windows.map((w, i) => ({
    start: w.start, end: w.end, title: `Source highlight ${i + 1}`, hook: "An automatically selected source preview",
    script: "This is an automatically selected preview from the source video. No specific spoken claim or visual event has been verified for this segment. Watch the original sequence for context, compare it with the rest of the source, and review this selection before sharing.",
    hashtags: "#Highlights", pinnedComment: "Review the original source for context.", hookScore: 0,
    evidence: "Automatic energy/spacing selection; no transcript-backed factual claims.",
  }));
}
