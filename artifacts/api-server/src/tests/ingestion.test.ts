import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataArguments, rangeArguments, ingestRange } from "../pipeline/ingestion";
import { parseJson3, parseTimedText, retainedRanges, boundedMoment } from "../pipeline/transcript";
test("metadata does not download and selected-range primary/fallback profiles remain bounded", async () => {
  const meta = metadataArguments("https://youtu.be/fixture");
  assert(meta.includes("--skip-download")); assert(!meta.includes("--download-sections"));
  assert(meta.includes("youtube:player_client=android,ios,web"));
  const calls: string[][] = [];
  await ingestRange("https://youtu.be/fixture", "/tmp/fixture.mp4", 120, 160, async (_exe, args) => {
    calls.push(args); if (calls.length === 1) throw new Error("Format unavailable"); return "";
  });
  assert.equal(calls.length, 2);
  for (const args of calls) { assert(args.includes("--download-sections")); assert(args.includes("*120.000-160.000")); assert(args.includes("--no-plugin-dirs")); }
  assert(!calls[1]!.includes("--extractor-args"));
  assert.throws(() => rangeArguments("https://youtu.be/fixture", "/tmp/fixture", 0, 600));
});
test("private/geo/DRM failures do not invoke another extractor", async () => {
  let calls = 0;
  await assert.rejects(ingestRange("https://youtu.be/fixture", "/tmp/fixture", 0, 35, async () => { calls++; throw new Error("DRM protected private video"); }));
  assert.equal(calls, 1);
});
test("timed captions are parsed, not invented; filler/gap cuts preserve source correspondence", () => {
  const segments = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "um" }] }, { tStartMs: 5000, dDurationMs: 35000, segs: [{ utf8: "Evidence from source." }] }] }, 45);
  assert.deepEqual(segments.map((s) => s.text), ["um", "Evidence from source."]);
  assert.deepEqual(parseJson3({}, 40), []);
  const kept = retainedRanges(0, 45, segments);
  const duration = kept.reduce((n, s) => n + s.end - s.start, 0);
  assert(duration >= 30 && duration < 45);
  assert(kept.every((s) => s.start >= 0 && s.end <= 45 && s.end > s.start));
});

test("accessible VTT and SRT tracks retain real cue timing and strip presentation tags", () => {
  const text = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500 align:start\n<c.green>Actual &amp; timed</c>\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond source cue\n\n00:01:01.000 --> 00:01:03.000\nOutside source";
  assert.deepEqual(parseTimedText(text, 30), [{ start: 1, end: 3.5, text: "Actual & timed" }, { start: 4, end: 6, text: "Second source cue" }]);
});
test("short AI windows gain real context without truncating proposed evidence or exceeding coverage", () => {
  assert.deepEqual(boundedMoment(20, 45, 45), { start: 15, end: 45 });
  assert.deepEqual(boundedMoment(0, 20, 45), { start: 0, end: 30 });
  assert.deepEqual(boundedMoment(10, 43, 45), { start: 10, end: 43 });
  assert.equal(boundedMoment(20, 50, 45), null);
  assert.equal(boundedMoment(0, 50, 60), null);
});
