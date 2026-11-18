import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestVod, vodArguments, sourceToolError, SourceIngestionError } from "./ingestion";

test("full VOD selection allows four hours without a truncated download section", () => {
  const args = vodArguments("https://youtu.be/authorized", "/tmp/test.mp4");
  assert(!args.includes("--download-sections"));
  assert(args.includes("!is_live & duration <= 14400"));
  assert(args.includes("youtube:player_client=ios,web")); assert(args.includes("--force-ipv4"));
  assert(args.includes("bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/bestvideo[ext=mp4][height<=1080]"));
});
test("fallback downloads the full source with a different client/stream profile", async () => {
  const attempts: string[][] = [];
  await ingestVod("https://youtu.be/authorized", "/tmp/test.mp4", async (_cmd, args) => {
    attempts.push(args);
    if (attempts.length === 1) throw new Error("HTTP Error 403: Forbidden");
    return "";
  });
  assert.equal(attempts.length, 2);
  assert(attempts[1]!.includes("youtube:player_client=ios,web"));
  assert(!attempts[1]!.includes("--download-sections"));
});
test("both failed attempts retain the actual error for the batch", async () => {
  await assert.rejects(
    ingestVod("https://youtu.be/authorized", "/tmp/test.mp4", async () => { throw new Error("ERROR: Video is private"); }),
    (error: unknown) => error instanceof Error && error.message.includes("ERROR: Video is private"),
  );
});
test("provider errors exclude signed URL queries and internal paths", () => {
  const error = sourceToolError("ERROR: HTTP 403 at https://example.com/video?secret=hidden /tmp/test.mp4");
  assert(error.includes("HTTP 403"));
  assert(!error.includes("hidden"));
  assert(!error.includes("/tmp/"));
});
