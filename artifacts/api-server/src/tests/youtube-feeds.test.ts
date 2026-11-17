import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import express from "express";
import { pool, db, type PoolClient } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseFeedInput, feedIdentity, resolveFeed, parseYoutubeFeed, fetchYoutubeFeed, FeedFetchError, youtubeVideoId, type FeedResult } from "../lib/youtube-feed-client";
import { claimFeed, pollFeed, admitFeedSources, feedTick } from "../lib/youtube-feeds";
import { recordYoutubeSubmission, DuplicateYoutubeSource } from "../lib/youtube-source-identity";
import { budgetTransaction, budgetStatus, setRenderCap, renderDay } from "../lib/render-budget";
import { runSlot } from "../pipeline/worker";
import { SourceIngestionError } from "../pipeline/ingestion";
import feedRouter from "../routes/youtube-feeds";
import autopilotRouter from "../routes/autopilot";
import { ListYoutubeFeedsResponse, GetAutopilotSwarmResponse } from "@workspace/api-zod";

// Isolated real PostgreSQL fixture. No external fetches, downloads, AI or publishing.
const schema = `feeds_${randomUUID().replaceAll("-", "")}`;
const migration = new URL("../../../../lib/db/migrations/20261117_youtube_feeds.sql", import.meta.url);
before(async () => {
  const c = await pool.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  (pool.options as { onConnect?: (c: PoolClient) => Promise<unknown> }).onConnect = (client) => client.query(`SET search_path TO "${schema}"`);
  try {
    await c.query(`SET search_path TO "${schema}"`);
    for (const table of ["projects", "generated_clips", "social_configs", "monetization_campaigns"]) {
      await c.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      if (table !== "social_configs") {
        await c.query(`CREATE SEQUENCE ${table}_fixture_id`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_id')`);
      }
    }
    for (const name of ["20261116_autopilot.sql", "20261116_render_guardrails.sql", "20261116_ai_usage.sql", "20261117_unified_posting.sql", "20261117_youtube_feeds.sql"]) {
      await c.query(await readFile(new URL(`../../../../lib/db/migrations/${name}`, import.meta.url), "utf8"));
    }
  } finally { c.release(); }
});
after(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
const owner = () => `fixture:${randomUUID()}`;
const channel = `UC${"a".repeat(22)}`, playlist = `PL${"b".repeat(32)}`;
const video = (n: number) => String(n).padStart(11, "0");
const xml = (ids: string[]) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Fixture feed</title>${ids.map((id) => `<entry><yt:videoId>${id}</yt:videoId><title>Authorized fixture</title></entry>`).join("")}</feed>`;
const response = (ids: string[]): FeedResult => ({ unchanged: false, entries: ids.map((videoId) => ({ videoId, title: "Authorized fixture" })), title: "Fixture feed", etag: '"fixture"', lastModified: null });
async function subscription(o: string, kind: "channel" | "playlist" = "channel") {
  const f = feedIdentity(kind, kind === "channel" ? channel : playlist);
  return (await pool.query(`INSERT INTO youtube_subscriptions(owner_id,kind,provider_id,feed_url,title) VALUES($1,$2,$3,$4,'Fixture') RETURNING id`, [o, kind, f.providerId, f.feedUrl])).rows[0].id as number;
}
async function due(id: number) { await pool.query("UPDATE youtube_subscriptions SET next_poll_at=now()-interval '1 second' WHERE id=$1", [id]); }
async function poll(o: string, ids: string[], id?: number) {
  if (id) await due(id);
  const claimed = await claimFeed(o);
  assert.ok(claimed);
  await pollFeed(claimed, async () => response(ids));
}
const status = (o: string) => budgetTransaction(o, (c) => budgetStatus(c, o));

test("supported IDs, standard URLs and canonical video identities reject arbitrary targets", async () => {
  for (const source of [channel, `https://www.youtube.com/channel/${channel}`, `https://youtube.com/channel/${channel}/videos`]) {
    assert.deepEqual(parseFeedInput(source), feedIdentity("channel", channel));
  }
  for (const source of [playlist, `https://m.youtube.com/playlist?list=${playlist}`]) assert.deepEqual(parseFeedInput(source), feedIdentity("playlist", playlist));
  for (const source of ["@creator", "https://www.youtube.com/@creator/shorts", "https://youtube.com/user/creator", "https://www.youtube.com/c/creator"]) assert.ok("channelPage" in parseFeedInput(source));
  for (const source of ["http://youtube.com/@creator", "https://youtube.com.evil/@creator", "https://user@youtube.com/@creator", "https://youtube.com:444/@creator", "https://127.0.0.1/", "https://youtube.com/watch?v=00000000001", "https://youtu.be/00000000001", "https://youtube.com/@creator?redirect=evil", "RDfoobar", "https://youtube.com/playlist?list=PLshort", "https://youtube.com/@a%2fb"]) assert.throws(() => parseFeedInput(source), source);
  for (const source of [`https://youtu.be/${video(1)}`, `https://youtube.com/shorts/${video(1)}`, `https://m.youtube.com/watch?feature=share&v=${video(1)}&t=2`]) assert.equal(youtubeVideoId(source), video(1));
  assert.equal(youtubeVideoId(`https://youtube.com.evil/watch?v=${video(1)}`), null);
  const calls: string[] = [];
  const resolved = await resolveFeed("@creator", (async (u) => {
    calls.push(String(u));
    return new Response(`<link rel="alternate" href="https://www.youtube.com/feeds/videos.xml?channel_id=${channel}">`);
  }) as typeof fetch);
  assert.deepEqual(resolved, feedIdentity("channel", channel));
  assert.deepEqual(calls, ["https://www.youtube.com/@creator"]);
});
test("safe redirects, HTTP errors, conditional fetches and response size/time bounds", async () => {
  let count = 0;
  for (const target of ["https://127.0.0.1/", "https://evil.test/", "https://youtube.com/watch?v=00000000001", "https://youtube.com/@creator?next=evil"]) {
    await assert.rejects(resolveFeed("@creator", (async () => { count++; return new Response(null, { status: 302, headers: { location: target } }); }) as typeof fetch), /redirect/);
  }
  assert.equal(count, 4); // Destination never fetched.
  assert.deepEqual(await resolveFeed("https://youtube.com/c/creator", (async () => new Response(null, { status: 302, headers: { location: `/channel/${channel}` } })) as typeof fetch), feedIdentity("channel", channel));
  await assert.rejects(resolveFeed("@creator", (async () => new Response(null, { status: 302, headers: { location: "/@creator" } })) as typeof fetch), /Too many/);
  await assert.rejects(resolveFeed("@creator", (async () => new Response("x".repeat(2097153))) as typeof fetch), /size limit/);
  await assert.rejects(resolveFeed("@creator", (async () => { throw new Error("timeout secret"); }) as typeof fetch), /timed out/);
  await assert.rejects(resolveFeed("@creator", (async () => new Response("<html>Consent required</html>")) as typeof fetch), /UC channel ID/);
  for (const status of [403, 404, 429, 500]) await assert.rejects(fetchYoutubeFeed(feedIdentity("channel", channel), {}, (async () => new Response(null, { status })) as typeof fetch), new RegExp(`HTTP ${status}`));
  const result = await fetchYoutubeFeed(feedIdentity("playlist", playlist), { etag: '"old"', lastModified: "yesterday" }, (async (u, init) => {
    assert.equal(String(u), `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist}`);
    assert.equal(init?.redirect, "manual"); assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"old"');
    assert.equal((init?.headers as Record<string, string>)["If-Modified-Since"], "yesterday");
    return new Response(null, { status: 304 });
  }) as typeof fetch);
  assert.equal(result.unchanged, true);
});
test("strict bounded XML accepts Atom and rejects entities, invalid IDs and malformed documents", () => {
  assert.equal(parseYoutubeFeed(xml([video(1), video(1)])).entries.length, 1);
  assert.equal(parseYoutubeFeed(xml([])).entries.length, 0);
  for (const invalid of ['<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml([]), xml([video(1)]).replace("</feed>", ""), xml(["not-video"]), "<rss/>", xml([]) + "x", "x".repeat(524289), xml([]).replace("</feed>", "<a>".repeat(30) + "</a>".repeat(30) + "</feed>")]) {
    assert.throws(() => parseYoutubeFeed(invalid), FeedFetchError);
  }
});
test("first successful poll baselines, later uploads queue once across subscriptions and owners stay isolated", async () => {
  const o = owner(), f = await subscription(o), p = await subscription(o, "playlist");
  await poll(o, [video(1)], f); await poll(o, [video(1)], p);
  assert.equal((await pool.query("SELECT count(*) FROM youtube_sources WHERE owner_id=$1", [o])).rows[0].count, "0");
  assert.ok((await pool.query("SELECT baseline_at FROM youtube_subscriptions WHERE id=$1", [f])).rows[0].baseline_at);
  await poll(o, [video(1), video(2)], f); await poll(o, [video(1), video(2)], p);
  assert.deepEqual(await Promise.all([admitFeedSources(o), admitFeedSources(o)]).then((r) => r.sort()), [0, 1]);
  assert.equal((await status(o)).reserved, 5);
  const jobs = await pool.query("SELECT * FROM autopilot_jobs WHERE owner_id=$1", [o]);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].status, "queued");
  const project = await pool.query("SELECT * FROM projects WHERE id=$1", [jobs.rows[0].project_id]);
  assert.equal(project.rows[0].mode, "commentary"); assert.equal(project.rows[0].clip_count, 3);
  await poll(o, [video(2)], f); assert.equal(await admitFeedSources(o), 0);
  const other = owner(), f2 = await subscription(other);
  await poll(other, [], f2); await poll(other, [video(2)], f2);
  assert.equal(await admitFeedSources(other), 1);
  // Deleting the media and subscription never resets dedup receipts.
  await pool.query("DELETE FROM projects WHERE id=$1", [project.rows[0].id]);
  await pool.query("DELETE FROM youtube_subscriptions WHERE owner_id=$1", [o]);
  const f3 = await subscription(o);
  await poll(o, [], f3); await poll(o, [video(2)], f3);
  assert.equal(await admitFeedSources(o), 0);
});
test("claims are exclusive; expired/stale leases and paused or removed feeds cannot commit a response", async () => {
  const o = owner(), f = await subscription(o);
  const claims = await Promise.all([claimFeed(o), claimFeed(o), claimFeed(o)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  await pool.query("UPDATE youtube_subscriptions SET lease_until=now()-interval '1 minute',next_poll_at=now()-interval '1 minute' WHERE id=$1", [f]);
  const current = await claimFeed(o); assert.ok(current); assert.notEqual(current.lease_token, old.lease_token);
  await pollFeed(old, async () => response([video(3)]));
  assert.equal((await pool.query("SELECT baseline_at FROM youtube_subscriptions WHERE id=$1", [f])).rows[0].baseline_at, null);
  await pollFeed(current, async () => response([]));
  await due(f); const paused = await claimFeed(o); assert.ok(paused);
  await pool.query("UPDATE youtube_subscriptions SET paused=true,lease_token=NULL,lease_until=NULL WHERE id=$1", [f]);
  await pollFeed(paused, async () => response([video(3)]));
  assert.equal(await admitFeedSources(o), 0);
  await pool.query("DELETE FROM youtube_subscriptions WHERE id=$1", [f]);
  await pollFeed(paused, async () => response([video(3)]));
  assert.equal((await pool.query("SELECT count(*) FROM youtube_sources WHERE owner_id=$1", [o])).rows[0].count, "0");
});
test("a killed poller and fresh admission process recover durable leases and budget-pending discoveries", async () => {
  const o = owner(), f = await subscription(o);
  await poll(o, [], f); await poll(o, [video(7)], f);
  await setRenderCap(o, 0); assert.equal(await admitFeedSources(o), 0);
  await due(f);
  const children: ChildProcess[] = [];
  const spawn = (action: string) => {
    const child = fork(fileURLToPath(new URL("./fixtures/youtube-feeds-process.ts", import.meta.url)), [schema, o, action], {
      execArgv: process.execArgv.filter((a) => a !== "--test"),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    return child;
  };
  const message = (child: ChildProcess) => new Promise<{ type: string; id?: number; count?: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture child timed out")), 15000);
    child.once("message", (m) => { clearTimeout(timer); resolve(m as { type: string; id?: number; count?: number }); });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error("Fixture child failed")); });
  });
  try {
    const first = spawn("claim");
    assert.equal((await message(first)).id, f);
    const ended = once(first, "exit"); first.kill("SIGKILL"); await ended;
    assert.equal(await claimFeed(o), null);
    await pool.query("UPDATE youtube_subscriptions SET lease_until=now()-interval '1 minute',next_poll_at=now()-interval '1 minute' WHERE id=$1", [f]);
    const recovered = await claimFeed(o); assert.ok(recovered);
    await pollFeed(recovered, async () => response([])); // Pending video no longer in RSS.
    await setRenderCap(o, 15);
    await pool.query("UPDATE youtube_sources SET retry_at=now()-interval '1 second' WHERE owner_id=$1", [o]);
    const fresh = spawn("admit"), freshExit = once(fresh, "exit");
    assert.equal((await message(fresh)).count, 1); await freshExit;
    assert.equal((await status(o)).reserved, 5);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
  }
});
test("clip cap, not source count; deferred uploads persist beyond feed windows and resume after midnight EST", async () => {
  const o = owner(), f = await subscription(o);
  await poll(o, [], f);
  await poll(o, [video(10), video(11), video(12), video(13)], f);
  assert.equal(await admitFeedSources(o), 3); // default 15 clips / 5 reserved per source
  assert.equal((await status(o)).reserved, 15);
  const pending = (await pool.query("SELECT * FROM youtube_sources WHERE owner_id=$1 AND state='pending'", [o])).rows[0];
  assert.equal(pending.reason, "daily_cap");
  assert.equal(new Date(pending.retry_at).getUTCHours(), 5);
  await poll(o, [], f); // Drops out of RSS, still persisted.
  assert.equal(await admitFeedSources(o), 0);
  const c = await pool.connect();
  try { assert.equal((await c.query("SELECT state FROM youtube_sources WHERE owner_id=$1 AND video_id=$2", [o, pending.video_id])).rows[0].state, "pending"); }
  finally { c.release(); }
  // Advance completed usage and pending eligibility over midnight without changing production's clock.
  await pool.query("UPDATE render_reservations SET completed_at=now()-interval '2 days' WHERE owner_id=$1", [o]);
  await pool.query("UPDATE autopilot_jobs SET status='completed' WHERE owner_id=$1", [o]);
  await pool.query("UPDATE youtube_sources SET retry_at=now()-interval '1 second' WHERE owner_id=$1 AND state='pending'", [o]);
  assert.equal(await admitFeedSources(o), 1);
  assert.equal((await status(o)).reserved, 5);
  for (const month of ["01", "07"]) assert.equal(renderDay(new Date(`2026-${month}-01T04:59:59Z`)).resetAt.toISOString(), `2026-${month}-01T05:00:00.000Z`);
});
test("pause/remove stops pending admissions; resume retains baseline and honors job safety quotas", async () => {
  const o = owner(), f = await subscription(o); await setRenderCap(o, 100);
  await poll(o, [], f); await poll(o, [video(21)], f);
  await pool.query("UPDATE youtube_subscriptions SET paused=true WHERE id=$1", [f]);
  assert.equal(await admitFeedSources(o), 0);
  await pool.query("UPDATE youtube_subscriptions SET paused=false WHERE id=$1", [f]);
  // Active historical sources count towards admission too.
  for (let i = 0; i < 10; i++) await pool.query("INSERT INTO projects(owner_id,title,source_url,mode,demo) VALUES($1,'Fixture','https://youtu.be/fixture','commentary',false)", [o]);
  assert.equal(await admitFeedSources(o), 0);
  assert.equal((await pool.query("SELECT reason FROM youtube_sources WHERE owner_id=$1", [o])).rows[0].reason, "job_quota");
  await pool.query("UPDATE projects SET status='completed' WHERE owner_id=$1", [o]);
  await pool.query("UPDATE youtube_sources SET retry_at=NULL WHERE owner_id=$1", [o]);
  assert.equal(await admitFeedSources(o), 1);
  await poll(o, [video(22)], f);
  await pool.query("DELETE FROM youtube_subscriptions WHERE id=$1", [f]);
  assert.equal(await admitFeedSources(o), 0);
});
test("manual submissions and historical projects are deduplicated transactionally and receipts survive deletion", async () => {
  const o = owner(), f = await subscription(o);
  const p = (await pool.query("INSERT INTO projects(owner_id,title,source_url,mode,demo) VALUES($1,'Fixture',$2,'commentary',false) RETURNING id", [o, `https://m.youtube.com/watch?feature=share&v=${video(31)}`])).rows[0];
  await pool.query(await readFile(migration, "utf8"));
  await pool.query(await readFile(migration, "utf8"));
  await poll(o, [], f); await poll(o, [video(31), video(32)], f);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${o}))`);
    await recordYoutubeSubmission(tx, o, `https://youtu.be/${video(32)}`, p.id, null);
  });
  assert.equal(await admitFeedSources(o), 0);
  await assert.rejects(recordYoutubeSubmission(db, o, `https://youtube.com/shorts/${video(32)}`, p.id, null), DuplicateYoutubeSource);
});
test("one malformed/unavailable feed does not block another; invalid media failures stay visible and release unused budget", async () => {
  const bad = owner(), good = owner(), bf = await subscription(bad), gf = await subscription(good);
  // Keep other fixtures out of this all-owner tick.
  await pool.query("UPDATE youtube_subscriptions SET next_poll_at=now()+interval '1 day' WHERE id<>ALL($1::int[])", [[bf, gf]]);
  await feedTick(() => false, async (identity) => {
    if (identity.kind === "channel") {
      // Scope fixture by the call's claim: use a deterministic first failure.
      if (!(await pool.query("SELECT error FROM youtube_subscriptions WHERE id=$1", [bf])).rows[0].error) throw new FeedFetchError("Malformed feed XML. No uploads were marked seen.");
    }
    return response([]);
  });
  assert.ok((await pool.query("SELECT error FROM youtube_subscriptions WHERE id=$1", [bf])).rows[0].error);
  assert.ok((await pool.query("SELECT baseline_at FROM youtube_subscriptions WHERE id=$1", [gf])).rows[0].baseline_at);
  await poll(good, [video(41)], gf);
  await admitFeedSources(good);
  await runSlot(0, async () => { throw new SourceIngestionError("Source is private, deleted, live or otherwise unsupported."); }, good);
  const job = (await pool.query("SELECT * FROM autopilot_jobs WHERE owner_id=$1", [good])).rows[0];
  assert.equal(job.status, "failed"); assert.match(job.error, /private/);
  assert.equal((await status(good)).reserved, 0);
});
test("authenticated API validates consent/IDs, enforces ownership and preserves queued work on pause/delete", async () => {
  const o = owner(), other = owner(), app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = req.header("x-owner") ?? o; req.isAuthenticated = (() => req.header("x-auth") !== "no") as typeof req.isAuthenticated; next(); });
  app.use(feedRouter); app.use(autopilotRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, method = "GET", body?: unknown, scope = o, auth = "yes") => fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json", "x-owner": scope, "x-auth": auth }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) assert.equal((await request(method === "GET" || method === "POST" ? "/autopilot/feeds" : "/autopilot/feeds/1", method, method === "GET" ? undefined : {}, o, "no")).status, 401);
    assert.equal((await request("/autopilot/feeds", "POST", { source: channel, authorizedUse: false })).status, 400);
    assert.equal((await request("/autopilot/feeds", "POST", { source: "https://evil.test/", authorizedUse: true })).status, 400);
    assert.equal((await request("/autopilot/feeds", "POST", { source: channel, authorizedUse: true })).status, 201);
    assert.equal((await request("/autopilot/feeds", "POST", { source: channel, authorizedUse: true })).status, 409);
    let list = ListYoutubeFeedsResponse.parse(await (await request("/autopilot/feeds")).json());
    const f = list.feeds[0].id;
    assert.equal(list.feeds[0].baselineAt, null);
    assert.equal(ListYoutubeFeedsResponse.parse(await (await request("/autopilot/feeds", "GET", undefined, other)).json()).feeds.length, 0);
    for (const method of ["PATCH", "DELETE"]) assert.equal((await request(`/autopilot/feeds/${f}`, method, { paused: true }, other)).status, 404);
    await poll(o, [], f); await poll(o, [video(51)], f); await admitFeedSources(o);
    const swarm = GetAutopilotSwarmResponse.parse(await (await request("/autopilot/swarm")).json());
    assert.equal(swarm.length, 1); assert.match(swarm[0].sourceUrl, /00000000051/);
    assert.equal((await request(`/autopilot/feeds/${f}`, "PATCH", { paused: true })).status, 200);
    list = ListYoutubeFeedsResponse.parse(await (await request("/autopilot/feeds")).json()); assert.equal(list.feeds[0].paused, true);
    assert.equal((await request(`/autopilot/feeds/${f}`, "PATCH", { paused: false })).status, 200);
    assert.equal((await request(`/autopilot/feeds/${f}`, "DELETE")).status, 204);
    assert.equal(GetAutopilotSwarmResponse.parse(await (await request("/autopilot/swarm")).json()).length, 1);
    // Cross-subscription/paste identity dedup; no second source created.
    const launched = await request("/autopilot/launch", "POST", { sources: [`https://youtu.be/${video(51)}`], idempotencyKey: randomUUID() });
    assert.equal(launched.status, 409);
  } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
});
