import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestVod, vodArguments, sourceToolError, SourceIngestionError } from "./ingestion";

test("full VOD selection allows one hour without a truncated download section", () => {
  const args = vodArguments("https://youtu.be/authorized", "/tmp/test.mp4");
  assert(!args.includes("--download-sections"));
  assert(args.includes("!is_live & duration <= 3600"));
  assert(args.includes("youtube:player_client=android,ios,web"));
  assert(args.includes("bestvideo[height<=1080]+bestaudio/best[height<=1080]"));
});
test("fallback downloads the full source with a different client/stream profile", async () => {
  const attempts: string[][] = [];
  await ingestVod("https://youtu.be/authorized", "/tmp/test.mp4", async (_cmd, args) => {
    attempts.push(args);
    if (attempts.length === 1) throw new Error("HTTP Error 403: Forbidden");
    return "";
  });
  assert.equal(attempts.length, 2);
  assert(!attempts[1]!.includes("--extractor-args"));
  assert(!attempts[1]!.includes("--download-sections"));
});
test("both failed attempts retain the actual error for the batch", async () => {
  await assert.rejects(
    ingestVod("https://youtu.be/authorized", "/tmp/test.mp4", async () => { throw new Error("ERROR: Video is private"); }),
    (error: unknown) => error instanceof SourceIngestionError && error.message.includes("ERROR: Video is private") && error.message.includes("Upload an authorized MP4"),
  );
});
test("provider errors exclude signed URL queries and internal paths", () => {
  const error = sourceToolError("ERROR: HTTP 403 at https://example.com/video?secret=hidden /tmp/test.mp4");
  assert(error.includes("HTTP 403"));
  assert(!error.includes("hidden"));
  assert(!error.includes("/tmp/"));
});
