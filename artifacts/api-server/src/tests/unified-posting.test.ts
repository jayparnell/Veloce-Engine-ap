import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db, pool, projectsTable, generatedClipsTable as clips, socialAccountsTable as accounts, publishQueueTable as queue, unifiedPostingSettingsTable as settings, type SocialAccount, type Clip } from "@workspace/db";
import { unifiedPublisher, discoverUnified, interpretUnified, safePostUrl, credentialHash, type UnifiedProvider } from "../publishing/unifiedPublisher";
import { ReconciliationRequired, ReviewRequired, type AdapterContext } from "../publishing/adapters";
import { ProviderError } from "../publishing/providers";
import { runPublishWork, recordPublishFailure } from "../publishing/publisher";
import { createUnifiedPostingRouter } from "../routes/unified-posting";
import { GetUnifiedPostingResponse } from "@workspace/api-zod";

assert.notEqual(process.env.NODE_ENV, "production", "Development fixtures only");
const owner = `user:unified-fixture-${randomUUID()}`;
const stranger = `user:unified-stranger-${randomUUID()}`;
const previousKey = process.env.SOCIAL_POST_API_KEY;
const previousOwner = process.env.SOCIAL_POST_OWNER_ID;
// Synthetic values are confined to this test process; no live provider receives a request.
process.env.SOCIAL_POST_API_KEY = "synthetic-fixture-key-not-a-credential";
process.env.SOCIAL_POST_OWNER_ID = owner;
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
let projectId: number;
before(async () => {
  const [project] = await db.insert(projectsTable).values({ ownerId: owner, title: "Synthetic unified posting", sourceUrl: "https://fixture.invalid/not-downloaded", mode: "commentary", status: "completed" }).returning();
  projectId = project!.id;
});
after(async () => {
  try {
    await db.delete(accounts).where(eq(accounts.ownerId, owner));
    await db.delete(settings).where(eq(settings.ownerId, owner));
    await db.delete(settings).where(eq(settings.ownerId, stranger));
    await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  } finally {
    if (previousKey === undefined) delete process.env.SOCIAL_POST_API_KEY; else process.env.SOCIAL_POST_API_KEY = previousKey;
    if (previousOwner === undefined) delete process.env.SOCIAL_POST_OWNER_ID; else process.env.SOCIAL_POST_OWNER_ID = previousOwner;
    await pool.end();
  }
});
function context(provider: UnifiedProvider, native = "youtube", transport: typeof fetch = async () => json({})): AdapterContext {
  const ctx: AdapterContext = {
    account: { provider: native, postingRoute: provider, unifiedAccountId: "account-1" } as SocialAccount,
    clip: { id: 42, title: "Fixture title", hashtags: "#Fixture", objectPath: "/objects/fixture", duration: 35 } as Clip,
    token: "", checkpoint: {}, request: transport,
    mediaUrl: async () => "https://storage.googleapis.com/fixture/video.mp4?temporary=fixture",
    bytes: async () => Buffer.from("not-read"),
    save: async (key, value) => { ctx.checkpoint[key] = value; },
    effect: async <T>(key: string, call: () => Promise<T>) => {
      const saved = ctx.checkpoint[`effect:${key}`] as { state: string; result: T } | undefined;
      if (saved?.state === "done") return saved.result;
      if (saved?.state === "started") throw new ReconciliationRequired("Uncertain fixture request");
      await ctx.save(`effect:${key}`, { state: "started" });
      const result = await call();
      await ctx.save(`effect:${key}`, { state: "done", result });
      return result;
    },
  };
  return ctx;
}
async function seed(route: UnifiedProvider = "late", checkpoint = {}) {
  const [clip] = await db.insert(clips).values({
    ownerId: owner, projectId, title: "Fixture", creator: "Synthetic", mode: "commentary", duration: 35, score: 0,
    hookScore: 0, visualScore: 0, commentaryScore: 0, hook: "Fixture", script: "Fixture", hashtags: "#Fixture",
    pinnedComment: "Fixture", status: "ready", demo: false, objectPath: "/objects/fixture-never-read",
  }).returning();
  const [account] = await db.insert(accounts).values({
    ownerId: owner, provider: "youtube", platform: "YouTube Shorts", remoteAccountId: randomUUID(),
    handle: "Synthetic", scopes: "", postingRoute: route, unifiedAccountId: "account-1", approved: true,
    connected: true, autoEnabled: true, autoEnabledAt: new Date("2099-01-01"), slots: ["12:30"],
  }).returning();
  await db.insert(settings).values({ ownerId: owner, provider: route, credentialHash: credentialHash() })
    .onConflictDoUpdate({ target: settings.ownerId, set: { provider: route, credentialHash: credentialHash() } });
  const [work] = await db.insert(queue).values({
    ownerId: owner, accountId: account!.id, clipId: clip!.id, scheduledAt: new Date("2099-01-01"), timezone: "UTC", checkpoint,
  }).returning();
  return { work: work!, account: account!, clip: clip! };
}

test("Ayrshare discovery uses native channel IDs and never invents accounts", async () => {
  const found = await discoverUnified("ayrshare", "fixture", async (url, init) => {
    assert.equal(String(url), "https://api.ayrshare.com/api/user");
    assert.equal(init!.redirect, "error");
    return json({ refId: "primary", activeSocialAccounts: ["youtube", "twitter"], displayNames: [
      { platform: "youtube", channelId: "UC-real", id: "google-not-channel", username: "Creator" },
      { platform: "twitter", id: "tweet-account", username: "creator" }, { platform: "facebook", id: "ignored" },
    ] });
  });
  assert.equal(found.length, 2); assert.equal(found[0]!.nativeId, "UC-real"); assert.equal(found[1]!.provider, "x");
});
test("Late discovery requires a native ID and respects disconnected accounts", async () => {
  const found = await discoverUnified("late", "fixture", async () => json({ accounts: [
    { _id: "a", platform: "youtube", platformUserId: "UC-native", profileId: { _id: "brand" }, username: "Creator", isActive: true },
    { _id: "b", platform: "instagram", isActive: true }, { _id: "c", platform: "twitter", platformUserId: "id", isActive: false },
  ] }));
  assert.deepEqual(found, [{ id: "a", nativeId: "UC-native", profileId: "brand", provider: "youtube", handle: "Creator" }]);
});
for (const provider of ["ayrshare", "late"] as const) {
  test(`${provider}: posts once using clip + slot idempotency; receipt resumes without another POST`, async () => {
    let posts = 0;
    const ctx = context(provider, "youtube", async (url, init) => {
      posts++;
      assert.equal(String(url), provider === "late" ? "https://zernio.com/api/v1/posts" : "https://api.ayrshare.com/api/post");
      const body = JSON.parse(String(init!.body));
      assert.equal(new Headers(init!.headers).get("Idempotency-Key"), "veloce:42:77");
      assert.equal(provider === "late" ? body.content : body.post, "Fixture title\n#Fixture");
      if (provider === "late") { assert.equal(body.publishNow, true); assert.equal(body.platforms[0].accountId, "account-1"); }
      else assert.equal(body.idempotencyKey, "veloce:42:77");
      return json(provider === "late"
        ? { post: { _id: "receipt", platforms: [{ platform: "youtube", accountId: "account-1", status: "published", platformPostId: "native", platformPostUrl: "https://youtube.com/watch?v=native" }] } }
        : { status: "success", id: "receipt", errors: [], postIds: [{ platform: "youtube", status: "success", id: "native", postUrl: "https://youtube.com/shorts/native" }] });
    });
    const result = await unifiedPublisher(ctx, provider, 77, "fixture");
    assert.equal(result.status, "published"); assert.equal(result.remoteId, "native");
    // Simulate a crash after the durable effect response but before the separate receipt.
    delete ctx.checkpoint.unifiedReceipt;
    assert.equal((await unifiedPublisher(ctx, provider, 77, "fixture")).remoteId, "native");
    assert.equal(posts, 1);
    assert.ok(!JSON.stringify(ctx.checkpoint).includes("temporary="));
  });
}
test("pending request ID is not a published native ID; polling confirms the exact target", async () => {
  let posts = 0, polls = 0;
  const ctx = context("late", "youtube", async (_url, init) => {
    if (init?.method === "POST") { posts++; return json({ post: { _id: "receipt", status: "processing", platforms: [] } }); }
    polls++;
    return json({ post: { _id: "receipt", platforms: [
      { platform: "youtube", accountId: "other", status: "published", platformPostId: "wrong" },
      { platform: "youtube", accountId: "account-1", status: "published", platformPostId: "native" },
    ] } });
  });
  assert.equal((await unifiedPublisher(ctx, "late", 77, "fixture")).status, "processing");
  assert.equal((await unifiedPublisher(ctx, "late", 77, "fixture")).remoteId, "native");
  assert.equal(posts, 1); assert.equal(polls, 1);
  assert.equal(interpretUnified("ayrshare", { id: "receipt", postIds: [{ platform: "tiktok", status: "success", id: "pending" }] }, "tiktok", "a").initial.status, "processing");
});
test("partial provider results never credit another platform's success", () => {
  const result = interpretUnified("ayrshare", { id: "receipt", errors: [{ platform: "youtube", message: "private details omitted" }], postIds: [{ platform: "twitter", status: "success", id: "tweet" }] }, "youtube", "a");
  assert.equal(result.initial.status, "failed"); assert.equal(result.initial.remoteId, undefined);
  assert.ok(!JSON.stringify(result).includes("private details"));
});
test("missing key performs no request or signed-media operation; TikTok cannot skip consent", async () => {
  let calls = 0;
  const ctx = context("late", "tiktok", async () => { calls++; return json({}); });
  ctx.mediaUrl = async () => { calls++; return "never"; };
  await assert.rejects(unifiedPublisher(ctx, "late", 1, ""), /configuration is missing/);
  await assert.rejects(unifiedPublisher(ctx, "late", 1, "fixture"), ReviewRequired);
  assert.equal(calls, 0);
});
for (const provider of ["ayrshare", "late"] as const) {
  test(`${provider}: TikTok retains explicit privacy, music consent and disclosure flags`, async () => {
    const ctx = context(provider, "tiktok", async (url, init) => {
      if (String(url).includes("creator_info")) return json({ data: {
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], comment_disabled: true, duet_disabled: true,
        stitch_disabled: true, max_video_post_duration_sec: 60,
      } });
      const body = JSON.parse(String(init!.body));
      const options = provider === "late" ? body.platforms[0].platformSpecificData.tiktokSettings : body.tikTokOptions;
      assert.equal(provider === "late" ? options.privacy_level : options.privacyLevel, "SELF_ONLY");
      assert.equal(provider === "late" ? options.disable_comment : options.disableComments, true);
      assert.equal(provider === "late" ? options.disable_duet : options.disableDuet, true);
      assert.equal(provider === "late" ? options.disable_stitch : options.disableStitch, true);
      assert.equal(provider === "late" ? options.brand_content_toggle : options.brandContent, false);
      assert.equal(provider === "late" ? options.brand_organic_toggle : options.brandOrganic, true);
      assert.equal(provider === "late" ? options.is_aigc : options.isAIGenerated, true);
      return json(provider === "late" ? { post: { _id: "receipt", platforms: [] } } : { id: "receipt", status: "success", postIds: [{ platform: "tiktok", status: "success", id: "pending" }] });
    });
    ctx.token = "synthetic-direct-creator-token";
    ctx.checkpoint.approval = { consent: true, disclosureReviewed: true, clipId: 42, objectPath: "/objects/fixture", caption: "Fixture title\n#Fixture",
      privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: true };
    assert.equal((await unifiedPublisher(ctx, provider, 77, "fixture")).status, "processing");
    assert.equal((ctx.checkpoint.approval as { consent: boolean }).consent, true);
  });
}
test("HTTP permissions, plan and rate-limit responses are sanitized and retain Retry-After", async () => {
  for (const status of [401, 402, 403, 429]) {
    await assert.rejects(discoverUnified("late", "fixture", async () => json({ error: "private account data" }, status, { "Retry-After": "120" })), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, status); assert.ok(!error.message.includes("private account data"));
      if (status === 429) assert.ok(error.notBefore!.getTime() > Date.now() + 110000);
      return true;
    });
  }
});
test("ambiguous HTTP failure retains a started mutation and prevents repeat", async () => {
  let calls = 0;
  const ctx = context("late", "youtube", async () => { calls++; return json({ error: "private" }, 503); });
  await assert.rejects(unifiedPublisher(ctx, "late", 1, "fixture"), ProviderError);
  await assert.rejects(unifiedPublisher(ctx, "late", 1, "fixture"), ReconciliationRequired);
  assert.equal(calls, 1);
});
test("safe URL validation excludes credentials, scripts and untrusted hosts", () => {
  for (const url of ["javascript:alert(1)", "https://attacker.invalid/post", "https://user:secret@x.com/post"]) assert.equal(safePostUrl(url), null);
  assert.equal(safePostUrl("https://x.com/creator/status/123?token=private"), "https://x.com/creator/status/123");
  assert.equal(safePostUrl("https://www.youtube.com/watch?v=native-id&token=private"), "https://www.youtube.com/watch?v=native-id");
});
test("database dispatcher polls saved receipt and persists real native ID and safe live URL", async () => {
  const { work } = await seed("late", { unifiedReceipt: { id: "receipt", initial: { status: "processing" } } });
  let requests = 0;
  await runPublishWork(work, async (url, init) => {
    requests++; assert.match(String(url), /\/posts\/receipt$/); assert.notEqual(init?.method, "POST");
    return json({ post: { _id: "receipt", platforms: [{ platform: "youtube", accountId: "account-1", status: "published", platformPostId: "native-id", platformPostUrl: "https://youtube.com/shorts/native-id" }] } });
  });
  const [stored] = await db.select().from(queue).where(eq(queue.id, work.id));
  assert.equal(stored!.status, "published"); assert.equal(stored!.remoteId, "native-id"); assert.equal(stored!.remoteUrl, "https://youtube.com/shorts/native-id");
  assert.equal(stored!.attempts, 0); assert.equal(requests, 1);
});
test("database dispatcher recovers a saved mutation response without sending again", async () => {
  const receipt = { id: "receipt", initial: { status: "published", remoteId: "confirmed-native", remoteUrl: "https://youtube.com/shorts/confirmed-native" } };
  const { work } = await seed("late", { "effect:unified-submit": { state: "done", result: receipt } });
  await runPublishWork(work, async () => { assert.fail("No provider mutation or upload may repeat"); });
  const [stored] = await db.select().from(queue).where(eq(queue.id, work.id));
  assert.equal(stored!.remoteId, "confirmed-native"); assert.equal(stored!.status, "published");
});
test("disconnect and cross-owner queue entries cannot reach the provider", async () => {
  const { work, account } = await seed();
  await db.update(accounts).set({ connected: false, autoEnabled: false }).where(eq(accounts.id, account.id));
  const noRequest: typeof fetch = async () => { assert.fail("Authorization must precede all remote operations"); };
  await assert.rejects(runPublishWork(work, noRequest), ReviewRequired);
  await assert.rejects(runPublishWork({ ...work, ownerId: stranger }, noRequest), ProviderError);
});
test("persisted uncertain unified mutation is reconciled, never repeated after restart", async () => {
  const { work } = await seed("late", { "effect:unified-submit": { state: "started" } });
  let caught: unknown;
  try { await runPublishWork(work, async () => { assert.fail("An ambiguous remote submission must not repeat"); }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof ReconciliationRequired);
  await recordPublishFailure(work, caught);
  const [stored] = await db.select().from(queue).where(eq(queue.id, work.id));
  assert.equal(stored!.status, "reconciliation_required"); assert.equal(stored!.remoteId, null); assert.equal(stored!.attempts, 0);
});
test("429 follows shared one-retry policy, honors Retry-After, and then fails terminally", async () => {
  const { work } = await seed();
  const notBefore = new Date(Date.now() + 120000);
  await recordPublishFailure(work, new ProviderError(429, "Unified provider rate limit reached.", notBefore));
  let [stored] = await db.select().from(queue).where(eq(queue.id, work.id));
  assert.equal(stored!.status, "retry"); assert.equal(stored!.attempts, 1); assert.ok(stored!.retryAt!.getTime() >= notBefore.getTime());
  await recordPublishFailure(stored!, new ProviderError(429, "Unified provider rate limit reached."));
  [stored] = await db.select().from(queue).where(eq(queue.id, work.id));
  assert.equal(stored!.status, "failed"); assert.equal(stored!.attempts, 2);
});
test("real routes: owner-only discovery, real mapping, no automatic enablement, no-key export fallback", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = String(req.headers["x-owner"] ?? owner); req.isAuthenticated = (() => true) as typeof req.isAuthenticated; next(); });
  let providerCalls = 0;
  app.use(createUnifiedPostingRouter(async () => {
    providerCalls++;
    return json({ accounts: [{ _id: "real-account", platform: "youtube", platformUserId: "UC-fixture", username: "Synthetic", profileId: "brand", isActive: true }] });
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = "GET", body?: unknown, identity = owner) => fetch(`${origin}/autopilot/unified${path}`, { method, headers: { "Content-Type": "application/json", "x-owner": identity }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("", "PUT", { provider: "late" })).status, 200);
    assert.equal((await call("/discover", "POST")).status, 200);
    const state = GetUnifiedPostingResponse.parse(await (await call("")).json());
    assert.equal(state.accounts[0]!.id, "real-account"); assert.ok(!JSON.stringify(state).includes("synthetic-fixture-key"));
    assert.equal((await call("/accounts", "POST", { id: "real-account" }, stranger)).status, 409);
    assert.equal((await call("/accounts", "POST", { id: "real-account" })).status, 200);
    const [mapped] = await db.select().from(accounts).where(and(eq(accounts.ownerId, owner), eq(accounts.remoteAccountId, "UC-fixture")));
    assert.equal(mapped!.postingRoute, "late"); assert.equal(mapped!.autoEnabled, false); assert.equal(mapped!.unifiedAccountId, "real-account");
    const strangerState = GetUnifiedPostingResponse.parse(await (await call("", "GET", undefined, stranger)).json());
    assert.deepEqual(strangerState.accounts, []);
    delete process.env.SOCIAL_POST_API_KEY;
    const noKey = GetUnifiedPostingResponse.parse(await (await call("")).json());
    assert.equal(noKey.ready, false); assert.match(noKey.message, /Export-only/); assert.deepEqual(noKey.accounts, []);
    assert.equal((await call("/discover", "POST")).status, 403);
    assert.equal(providerCalls, 1);
  } finally {
    process.env.SOCIAL_POST_API_KEY = "synthetic-fixture-key-not-a-credential";
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
