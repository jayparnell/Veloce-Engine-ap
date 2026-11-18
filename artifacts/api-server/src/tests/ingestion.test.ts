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
import { parseJson3, parseTimedText, retainedRanges, boundedMoment, getSourceMetadata } from "../pipeline/transcript";
import { groundedMoments, fallbackMoments, fallbackWindows, hasSpeech } from "../pipeline/moments";
test("metadata stays lightweight and full-source retries never request remote sections", async () => {
  const meta = metadataArguments("https://youtu.be/fixture");
  assert(meta.includes("--skip-download")); assert(!meta.includes("--download-sections"));
  assert(meta.includes("youtube:player_client=ios,web")); assert(meta.includes("--force-ipv4"));
  const calls: string[][] = [];
  await ingestVod("https://youtu.be/fixture", "/tmp/fixture.mp4", async (_exe, args) => {
    calls.push(args); if (calls.length === 1) throw new Error("Format unavailable"); return "";
  });
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert(!args.includes("--download-sections")); assert(args.includes("--no-plugin-dirs"));
    assert.equal(args[args.indexOf("-f") + 1], "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/bestvideo[ext=mp4][height<=1080]");
    assert(args.includes("--no-continue")); assert.equal(args[args.indexOf("--concurrent-fragments") + 1], "1");
  }
  assert(calls[1]!.includes("youtube:player_client=ios,web"));
  assert(!calls[1]!.includes("--no-check-certificates"));
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
  assert(duration >= 15 && duration < 45);
  assert(kept.every((s) => s.start >= 0 && s.end <= 45 && s.end > s.start));
});

test("accessible VTT and SRT tracks retain real cue timing and strip presentation tags", () => {
  const text = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500 align:start\n<c.green>Actual &amp; timed</c>\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond source cue\n\n00:01:01.000 --> 00:01:03.000\nOutside source";
  assert.deepEqual(parseTimedText(text, 30), [{ start: 1, end: 3.5, text: "Actual & timed" }, { start: 4, end: 6, text: "Second source cue" }]);
});
test("short AI windows gain real context without truncating proposed evidence or exceeding coverage", () => {
  assert.deepEqual(boundedMoment(20, 45, 45), { start: 20, end: 45 });
  assert.deepEqual(boundedMoment(0, 20, 45), { start: 0, end: 20 });
  assert.deepEqual(boundedMoment(10, 43, 45), { start: 10, end: 43 });
  assert.equal(boundedMoment(20, 50, 45), null);
  assert.deepEqual(boundedMoment(0, 55, 60), { start: 0, end: 55 });
  assert.deepEqual(boundedMoment(0, 10, 15), { start: 0, end: 15 });
  assert.equal(boundedMoment(0, 56, 60), null);
});
test("bot checks retry once with a fresh connection, exact raw proxy and bot-only fallback flags", async () => {
  const { prepareYtdlpArguments } = await import("../pipeline/youtube-network");
  const proxy = "http://fixture%2Buser:fixture%40pass@gw.dataimpulse.com:823";
  for (const operation of ["download", "metadata"]) {
    const calls: string[][] = [];
    const execute = async (_exe: string, args: string[]) => {
      const prepared = await prepareYtdlpArguments(args, { PROXY_URL: proxy });
      calls.push(prepared);
      assert.equal(prepared[prepared.indexOf("--proxy") + 1], proxy);
      assert(prepared.includes("--force-ipv4"));
      assert(prepared.includes("youtube:player_client=ios,web"));
      if (calls.length === 1) throw new Error("Sign in to confirm you're not a bot");
      return JSON.stringify({ title: "fixture", duration: 14400 });
    };
    if (operation === "download") await ingestVod("https://youtu.be/fixture", "/tmp/fixture.mp4", execute);
    else await getSourceMetadata("https://youtu.be/fixture", execute);
    assert.equal(calls.length, 2);
    assert(!calls[0]!.includes("--no-check-certificates"));
    assert(calls[1]!.includes("--no-check-certificates")); assert(calls[1]!.includes("--geo-bypass"));
  }
  let attempts = 0;
  await assert.rejects(ingestVod("https://youtu.be/fixture", "/tmp/fixture.mp4", async () => {
    attempts++; throw new Error("Sign in to confirm you're not a bot");
  }), /Sign in to confirm/);
  assert.equal(attempts, 2);
});
test("source metadata accepts 15 seconds through four hours and rejects live, invalid or over-limit sources", async () => {
  for (const duration of [15, 3600, 3601, 14399, 14400]) {
    assert.equal((await getSourceMetadata("fixture", async () => JSON.stringify({ duration }))).duration, duration);
  }
  for (const duration of [14.9, 14400.1, null]) {
    await assert.rejects(getSourceMetadata("fixture", async () => JSON.stringify({ duration })), /240-minute/);
  }
  await assert.rejects(getSourceMetadata("fixture", async () => JSON.stringify({ duration: 60, is_live: true })), /completed/);
});
test("one or two grounded moments are kept; invalid suggestions and excess clips do not fail the batch", () => {
  const transcript = [{ start: 0, end: 200, text: "This is a real transcript excerpt with enough actual words to make a grounded selection possible." }];
  assert(hasSpeech(transcript)); assert(!hasSpeech([{ start: 0, end: 1, text: "[Music]" }]));
  const moment = { start: 0, end: 15, title: "Fixture", hook: "Fixture hook", script: "A grounded analytical script.", hashtags: "", pinnedComment: "", hookScore: 50, evidence: "real transcript excerpt" };
  for (const count of [1, 2, 3, 4]) {
    const result = groundedMoments({ moments: [null, { ...moment, evidence: "made up evidence" }, ...Array.from({ length: count }, (_, i) => ({ ...moment, start: i * 40, end: i * 40 + (i ? 55 : 15) }))] }, transcript, 200);
    assert.equal(result.length, Math.min(count, 3));
  }
  assert.deepEqual(groundedMoments({ moments: [] }, [], 60), []);
  assert.deepEqual(groundedMoments(null, transcript, 60), []);
});
test("sparse and silent sources get bounded, evenly spaced previews; energy scans prefer distinct louder windows", async () => {
  for (const duration of [15, 20, 55, 100, 120, 14400]) {
    const windows = fallbackWindows(duration);
    assert(windows.length >= 1 && windows.length <= 3);
    assert(windows.every(w => w.start >= 0 && w.end <= duration && w.end - w.start >= 15 && w.end - w.start <= 55));
    const silent = await fallbackMoments("fixture.mp4", duration, async () => "lavfi.astats.Overall.RMS_level=-inf");
    assert.deepEqual(silent.map(({ start, end }) => ({ start, end })), windows);
    assert(silent.every(m => m.script.includes("No specific spoken claim or visual event has been verified")));
  }
  let scanned = 0;
  const peaks = await fallbackMoments("fixture.mp4", 400, async (_exe, args) => {
    scanned++; const at = Number(args[args.indexOf("-ss") + 1]);
    return `lavfi.astats.Overall.RMS_level=${at === 180 ? -1 : -40}`;
  });
  assert.equal(scanned, 9); assert.equal(peaks.length, 3); assert(peaks.some(p => p.start === 180));
  const unscannable = await fallbackMoments("silent-video.mp4", 400, async () => { throw new Error("No audio stream"); });
  assert.deepEqual(unscannable.map(({ start, end }) => ({ start, end })), fallbackWindows(400));
  await assert.rejects(fallbackMoments("fixture.mp4", 400, async () => { throw new JobStoppedError("Processing cancelled."); }), JobStoppedError);
});
test("15- and 55-second local cuts retain their full duration and RMS scanning runs on real local media", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flexible-moments-"));
  try {
    const source = join(dir, "source.mp4");
    await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=5:d=56", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=56", "-t", "56", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
    for (const length of [15, 55]) {
      const output = join(dir, `cut-${length}.mp4`);
      await command("ffmpeg", sliceArguments(source, output, 0, length));
      const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-of", "json", output]));
      assert(Math.abs(Number(probe.format.duration) - length) < .3);
    }
    assert.equal((await fallbackMoments(source, 56, command)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
