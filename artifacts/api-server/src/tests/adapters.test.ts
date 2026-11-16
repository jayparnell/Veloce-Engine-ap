import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip, SocialAccount, Checkpoint } from "@workspace/db";
import { publishAdapter, ReconciliationRequired, ReviewRequired, type AdapterContext } from "../publishing/adapters";
import { encryptTokens } from "../publishing/providers";
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
function fixture(provider: string, handler: (url: string, init?: RequestInit) => Promise<Response>, checkpoint: Checkpoint = {}) {
  const ctx: AdapterContext = {
    account: { provider, remoteAccountId: "test-account" } as SocialAccount,
    clip: { id: 123, objectPath: "/objects/fixture", title: "Fixture", hashtags: "#Fixture", language: "en", duration: 35 } as Clip,
    checkpoint, token: "synthetic-test-token", bytes: async () => Buffer.from("fixture-video"),
    mediaUrl: async () => "https://fixture.invalid/authorized-signed-media", request: handler as typeof fetch,
    save: async (key, value) => { ctx.checkpoint[key] = value; },
    effect: async <T>(key: string, call: () => Promise<T>) => {
      const saved = ctx.checkpoint[`effect:${key}`] as { state: string; result: T } | undefined;
      if (saved?.state === "done") return saved.result;
      if (saved?.state === "started") throw new ReconciliationRequired("Uncertain effect; not repeated");
      await ctx.save(`effect:${key}`, { state: "started" });
      const result = await call(); await ctx.save(`effect:${key}`, { state: "done", result }); return result;
    },
  };
  return ctx;
}
test("YouTube reconciles a completed resumable upload without another upload", async () => {
  let calls = 0;
  const ctx = fixture("youtube", async (_url, init) => { calls++; assert.equal(init?.method, "PUT"); assert.equal((init.headers as Record<string, string>)["Content-Range"], "bytes */13"); return json({ id: "remote-video" }); },
    { youtubeSession: encryptTokens("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture") });
  assert.deepEqual(await publishAdapter(ctx), { status: "published", remoteId: "remote-video" }); assert.equal(calls, 1);
});
test("YouTube expired session requires reconciliation, never new upload", async () => {
  const ctx = fixture("youtube", async () => json({ error: "expired" }, 404), { youtubeSession: encryptTokens("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture") });
  await assert.rejects(publishAdapter(ctx), ReconciliationRequired);
});
test("TikTok has no default privacy or implicit per-video consent", async () => {
  const ctx = fixture("tiktok", async () => { throw new Error("Must not contact provider"); });
  await assert.rejects(publishAdapter(ctx), ReviewRequired);
});
test("TikTok refuses partner brand content without an explicit public choice", async () => {
  const ctx = fixture("tiktok", async () => { throw new Error("No provider request is permitted"); }, {
    approval: { privacyLevel: "SELF_ONLY", consent: true, disclosureReviewed: true, brandContent: true, brandOrganic: false, clipId: 123, objectPath: "/objects/fixture", caption: "Fixture\n#Fixture" },
  });
  await assert.rejects(publishAdapter(ctx), ReviewRequired);
});
test("TikTok sends reviewed commercial and generated-content disclosures", async () => {
  let initialized = false;
  const ctx = fixture("tiktok", async (url, init) => {
    if (url.includes("creator_info")) return json({ data: { privacy_level_options: ["PUBLIC_TO_EVERYONE"], max_video_post_duration_sec: 60 } });
    if (url.includes("video/init")) {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.post_info.brand_content_toggle, true);
      assert.equal(body.post_info.brand_organic_toggle, false);
      assert.equal(body.post_info.is_aigc, true);
      initialized = true;
      return json({ data: { publish_id: "synthetic-publish", upload_url: "https://open-upload.tiktokapis.com/fixture" } });
    }
    return json({ data: { status: "PROCESSING_DOWNLOAD" } });
  }, { approval: { privacyLevel: "PUBLIC_TO_EVERYONE", consent: true, disclosureReviewed: true, brandContent: true, brandOrganic: false, clipId: 123, objectPath: "/objects/fixture", caption: "Fixture\n#Fixture" } });
  assert.deepEqual(await publishAdapter(ctx), { status: "processing" });
  assert.equal(initialized, true);
});
test("TikTok completed processing without post ID is not marked published", async () => {
  const ctx = fixture("tiktok", async () => json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } }), { tiktokPublishId: "saved-publish-id" });
  await assert.rejects(publishAdapter(ctx), ReconciliationRequired);
});
test("Instagram published container without saved media ID is reconciled, not posted twice", async () => {
  let writes = 0;
  const ctx = fixture("instagram", async (_url, init) => { if (init?.method === "POST") writes++; return json({ status_code: "PUBLISHED" }); }, { instagramContainer: "saved-container" });
  await assert.rejects(publishAdapter(ctx), ReconciliationRequired); assert.equal(writes, 0);
});
test("Instagram waits for real media readiness before publishing", async () => {
  const ctx = fixture("instagram", async () => json({ status_code: "IN_PROGRESS" }), { instagramContainer: "saved-container" });
  assert.deepEqual(await publishAdapter(ctx), { status: "processing" });
});
test("X post timeout checkpoint is not blindly duplicated", async () => {
  let writes = 0;
  const ctx = fixture("x", async (_url, init) => { if (init?.method === "POST") writes++; return json({ data: { processing_info: { state: "succeeded" } } }); },
    { xMediaId: "saved-media", xFinalized: true, "effect:x-post": { state: "started" } });
  await assert.rejects(publishAdapter(ctx), ReconciliationRequired); assert.equal(writes, 0);
});
test("X records only the actual confirmed remote ID", async () => {
  const ctx = fixture("x", async (url) => url.endsWith("/tweets") ? json({ data: { id: "confirmed-post" } }) : json({ data: { processing_info: { state: "succeeded" } } }),
    { xMediaId: "saved-media", xFinalized: true });
  assert.deepEqual(await publishAdapter(ctx), { status: "published", remoteId: "confirmed-post" });
});
test("provider quota errors are surfaced rather than simulated success", async () => {
  const ctx = fixture("instagram", async () => json({ error: { code: 4 } }, 429));
  await assert.rejects(publishAdapter(ctx), /quota|rate limit/);
});
