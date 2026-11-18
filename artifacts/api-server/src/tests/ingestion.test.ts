import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataArguments, vodArguments, sliceArguments, ingestVod } from "../pipeline/ingestion";
import { mkdtemp, rm, copyFile, writeFile, stat, access } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobSource } from "../pipeline/job-source";
import { command } from "../pipeline/process";
import { JobStoppedError, jobContext, type JobContext } from "../pipeline/job-context";
import { parseJson3, parseTimedText, retainedRanges, boundedMoment } from "../pipeline/transcript";
test("metadata stays lightweight and full-source retries never request remote sections", async () => {
  const meta = metadataArguments("https://youtu.be/fixture");
  assert(meta.includes("--skip-download")); assert(!meta.includes("--download-sections"));
  assert(meta.includes("youtube:player_client=android,ios,web"));
  const calls: string[][] = [];
  await ingestVod("https://youtu.be/fixture", "/tmp/fixture.mp4", async (_exe, args) => {
    calls.push(args); if (calls.length === 1) throw new Error("Format unavailable"); return "";
  });
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert(!args.includes("--download-sections")); assert(args.includes("--no-plugin-dirs"));
    assert.equal(args[args.indexOf("-f") + 1], "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]");
    assert(args.includes("--no-continue")); assert.equal(args[args.indexOf("--concurrent-fragments") + 1], "1");
  }
  assert(!calls[1]!.includes("--extractor-args"));
  assert.throws(() => sliceArguments("/tmp/fixture.mp4", "/tmp/clip.mp4", 0, 600));
});
test("private/geo/DRM failures do not invoke another extractor", async () => {
  let calls = 0;
  await assert.rejects(ingestVod("https://youtu.be/fixture", "/tmp/fixture", async () => { calls++; throw new Error("DRM protected private video"); }));
  assert.equal(calls, 1);
});
test("one full VOD supplies three real local ffmpeg slices and cleanup removes all download intermediates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vod-fixture-"));
  let downloads = 0, parts = "";
  const input = join(dir, "fixture.mp4");
  const source = new JobSource(randomInt(100000000, 200000000), "https://youtu.be/fixture", async (exe, args) => {
    assert.equal(exe, "yt-dlp"); downloads++;
    const paths = args.flatMap((value, i) => value === "--paths" ? [args[i + 1]!] : []);
    parts = paths.find(p => p.startsWith("temp:"))!.slice(5);
    assert(paths.includes("home:/tmp"));
    assert.equal(args[args.indexOf("-o") + 1], source.path.split("/").at(-1));
    await writeFile(join(parts, "partial-stream.part"), "fixture");
    await copyFile(input, source.path); return "";
  });
  try {
    await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", input]);
    assert.deepEqual(await Promise.all([source.get(), source.get(), source.get()]), [source.path, source.path, source.path]);
    for (let i = 0; i < 3; i++) {
      const target = join(dir, `clip-${i}.mp4`);
      await command("ffmpeg", sliceArguments(await source.get(), target, i * 2, i * 2 + 1));
      const info = JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", target]));
      assert(Math.abs(Number(info.format.duration) - 1) < .15);
      assert.equal(info.streams.find((s: { codec_type: string }) => s.codec_type === "video").codec_name, "h264");
    }
    const audio = join(dir, "analysis.mp3");
    await command("ffmpeg", sliceArguments(await source.get(), audio, 0, 2, true));
    assert((await stat(audio)).size > 0);
    assert.equal(downloads, 1);
    await source.cleanup();
    await assert.rejects(access(source.path));
    await assert.rejects(access(parts));
  } finally { await source.cleanup(); await rm(dir, { recursive: true, force: true }); }
});
test("failed downloads clean partial MP4s and Retry can download fresh", async () => {
  let attempts = 0, fail = true; const parts: string[] = [];
  const source = new JobSource(randomInt(200000001, 300000000), "https://youtu.be/fixture", async (_exe, args) => {
    attempts++;
    const index = args.findIndex((v, i) => v === "--paths" && args[i + 1]?.startsWith("temp:"));
    parts.push(args[index + 1]!.slice(5));
    await writeFile(source.path, "partial");
    if (fail) throw new Error("fixture connection reset");
    return "";
  });
  try {
    const orphan = await mkdtemp(`${source.path}.parts-`);
    await writeFile(join(orphan, "interrupted.part"), "old attempt");
    await writeFile(source.path, "old interrupted source");
    await assert.rejects(source.get(), error => error instanceof Error && /Full-source download failed/.test(error.message) && !/authorized MP4|No full-VOD fallback/.test(error.message));
    assert.equal(attempts, 2);
    await assert.rejects(access(orphan));
    await assert.rejects(access(source.path));
    for (const path of parts) await assert.rejects(access(path));
    fail = false;
    assert.equal(await source.get(), source.path);
    assert.equal(attempts, 3);
  } finally { await source.cleanup(); }
});
test("cancellation stops after one attempt and cleans the full-source file", async () => {
  let attempts = 0;
  const stopped = new JobStoppedError("Processing cancelled.");
  const source = new JobSource(randomInt(300000001, 400000000), "https://youtu.be/fixture", async () => {
    attempts++; await writeFile(source.path, "partial"); throw stopped;
  });
  await assert.rejects(source.get(), error => error === stopped);
  assert.equal(attempts, 1); await assert.rejects(access(source.path));
});
test("a cancelled subprocess reports cancellation rather than a source retrieval failure", async () => {
  const abort = new AbortController();
  const ctx = { abort } as JobContext;
  await jobContext.run(ctx, async () => {
    const pending = command(process.execPath, ["-e", "setInterval(()=>{},1000)"], 5000);
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(pending, JobStoppedError);
  });
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
