import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import express from "express";
import { db, pool, projectsTable, autopilotJobsTable as jobs, aiCheckpointsTable as ai, publishQueueTable as queue,
  socialAccountsTable as accounts, generatedClipsTable as clips, type PoolClient } from "@workspace/db";
import { eq } from "drizzle-orm";
import { renderDay, reserveOutputs, commitOutput, budgetTransaction, budgetStatus, setRenderCap, RenderBudgetPaused, RenderCapConflict, releaseOutputs } from "../lib/render-budget";
import { redactError, nextFailure } from "../lib/failure-policy";
import { runSlot } from "../pipeline/worker";
import { JobContext, AIRequestRejectedError } from "../pipeline/job-context";
import { publisherTick, recordPublishFailure } from "../publishing/publisher";
import { ProviderError, readJson } from "../publishing/providers";
import { ReconciliationRequired, ReviewRequired } from "../publishing/adapters";
import autopilotRouter from "../routes/autopilot";
import { GetRenderBudgetResponse, GetAutopilotSwarmResponse } from "@workspace/api-zod";

// Real PostgreSQL locks/transactions in an isolated schema. No downloads, AI or provider writes.
const schema = `guardrails_${randomUUID().replaceAll("-", "")}`;
before(async () => {
  const c = await pool.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  (pool.options as { onConnect?: (c: PoolClient) => Promise<unknown> }).onConnect = (client) => client.query(`SET search_path TO "${schema}"`);
  try {
    await c.query(`SET search_path TO "${schema}"`);
    for (const table of ["projects", "generated_clips", "social_configs"]) {
      await c.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      if (table !== "social_configs") {
        await c.query(`CREATE SEQUENCE ${table}_fixture_id`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_id')`);
      }
    }
    await c.query(await readFile(new URL("../../../../lib/db/migrations/20261116_autopilot.sql", import.meta.url), "utf8"));
    await c.query(await readFile(new URL("../../../../lib/db/migrations/20261116_render_guardrails.sql", import.meta.url), "utf8"));
  } finally { c.release(); }
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
const owner = () => `fixture:${randomUUID()}`;
async function makeJob(ownerId: string, processing = true) {
  const [p] = await db.insert(projectsTable).values({ ownerId, title: "Authorized fixture", sourceUrl: "https://youtu.be/fixture", mode: "commentary", demo: false }).returning();
  const [j] = await db.insert(jobs).values({ ownerId, projectId: p!.id, requestKey: randomUUID(), inputHash: "fixture", status: processing ? "processing" : "queued", leaseToken: processing ? randomUUID() : null }).returning();
  return j!;
}
async function getJob(id: number) { return (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!; }
const status = (o: string) => budgetTransaction(o, (c) => budgetStatus(c, o));

test("EST reset is fixed UTC-05 in summer and winter, exactly at 05:00 UTC", () => {
  for (const month of ["01", "07"]) {
    assert.equal(renderDay(new Date(`2026-${month}-12T04:59:59Z`)).resetAt.toISOString(), `2026-${month}-12T05:00:00.000Z`);
    assert.equal(renderDay(new Date(`2026-${month}-12T05:00:00Z`)).start.toISOString(), `2026-${month}-12T05:00:00.000Z`);
  }
});
test("parallel multi-source reservations are atomic; originals, variants and retries share one allowance", async () => {
  const o = owner(), batch = await Promise.all(Array.from({ length: 6 }, () => makeJob(o)));
  const results = await Promise.allSettled(batch.map((j) => reserveOutputs(o, j.id, 5, j.leaseToken!)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason instanceof RenderBudgetPaused).length, 3);
  assert.deepEqual({ reserved: (await status(o)).reserved, remaining: (await status(o)).remaining }, { reserved: 15, remaining: 0 });
  const admitted = batch[results.findIndex((r) => r.status === "fulfilled")]!;
  await reserveOutputs(o, admitted.id, 5, admitted.leaseToken!);
  await reserveOutputs(o, admitted.id, 3, admitted.leaseToken!);
  const variants = await Promise.all([makeJob(o), makeJob(o)]);
  await Promise.all(variants.map((j) => reserveOutputs(o, j.id, 1, j.leaseToken!)));
  assert.equal((await status(o)).reserved, 15);
  await assert.rejects(setRenderCap(o, 14), RenderCapConflict);
  assert.equal((await status(owner())).dailyRenderCap, 15);
});
test("partial completion commits once, survives midnight and cannot be refunded by deletion or replay", async () => {
  const o = owner(), j = await makeJob(o);
  await setRenderCap(o, 5);
  await reserveOutputs(o, j.id, 5, j.leaseToken!);
  let writes = 0;
  await commitOutput(o, j.id, 0, j.leaseToken!, async () => { writes++; });
  await commitOutput(o, j.id, 0, j.leaseToken!, async () => { writes++; });
  assert.equal(writes, 1);
  assert.equal((await status(o)).completed, 1);
  assert.equal((await status(o)).reserved, 4);
  // Simulate the clock advancing past reset by moving only the completed receipt to yesterday.
  await pool.query("UPDATE render_reservations SET completed_at=completed_at-interval '1 day' WHERE job_id=$1 AND completed_at IS NOT NULL", [j.id]);
  assert.equal((await status(o)).completed, 0);
  assert.equal((await status(o)).reserved, 4); // carry-over prevents overbooking ongoing work
  await reserveOutputs(o, j.id, 5, j.leaseToken!);
  await commitOutput(o, j.id, 0, j.leaseToken!, async () => { writes++; });
  assert.equal(writes, 1);
  await commitOutput(o, j.id, 1, j.leaseToken!, async () => {});
  assert.equal((await status(o)).completed, 1);
  await assert.rejects(commitOutput(o, j.id, 2, "stale-worker", async () => assert.fail("stale writer")));
  await assert.rejects(commitOutput(o, j.id, 2, j.leaseToken!, async () => { throw new Error("output write lost"); }));
  assert.equal((await status(o)).reserved, 3);
  await db.delete(projectsTable).where(eq(projectsTable.id, j.projectId));
  await releaseOutputs(o, j.id);
  assert.equal((await status(o)).completed, 1);
});
test("zero cap prevents any processing; raising it wakes budget-paused work without counting a failure", async () => {
  const o = owner(), j = await makeJob(o, false);
  await setRenderCap(o, 0);
  let calls = 0;
  await runSlot(0, async () => { calls++; }, o);
  const paused = await getJob(j.id);
  assert.equal(paused.status, "budget_paused");
  assert.equal(paused.failures, 0);
  assert.equal(paused.retryAt!.toISOString(), (await status(o)).resetAt);
  assert.equal(calls, 0);
  await setRenderCap(o, 5);
  await runSlot(0, async () => { calls++; }, o);
  assert.equal(calls, 1);
  assert.equal((await getJob(j.id)).status, "completed");
  assert.equal((await status(o)).reserved, 0);
});
test("worker retries once after 60 seconds, persists failures, reuses AI checkpoints and leaves other work moving", async () => {
  const o = owner(), j = await makeJob(o, false);
  let aiCalls = 0;
  const fail = async (ctx: JobContext) => {
    const value = await ctx.ai("saved", async () => { aiCalls++; return { answer: "done" }; });
    assert.equal(value.answer, "done");
    await ctx.save("asset", { objectPath: "/objects/synthetic-saved" });
    throw new Error("Renderer temporary failure api_key=synthetic-secret https://provider.invalid/?token=synthetic");
  };
  await Promise.all([runSlot(0, fail, o), runSlot(1, fail, o)]);
  let current = await getJob(j.id);
  assert.equal(current.status, "retry");
  assert.equal(current.failures, 1);
  assert.ok(current.retryAt!.getTime() >= current.updatedAt.getTime() + 59900);
  assert.ok(!current.error!.includes("synthetic-secret"));
  await runSlot(2, fail, o);
  assert.equal(aiCalls, 1); // retry not due
  const other = await makeJob(o, false);
  await runSlot(2, async () => {}, o);
  assert.equal((await getJob(other.id)).status, "completed");
  await db.update(jobs).set({ retryAt: new Date(0) }).where(eq(jobs.id, j.id));
  // New JobContext and slot model a restart; state comes only from Postgres.
  await runSlot(3, fail, o);
  current = await getJob(j.id);
  assert.equal(current.status, "failed");
  assert.equal(current.failures, 2);
  assert.equal(aiCalls, 1);
  assert.deepEqual(current.checkpoint.asset, { objectPath: "/objects/synthetic-saved" });
  assert.equal((await status(o)).reserved, 0);
  await runSlot(4, fail, o);
  assert.equal((await getJob(j.id)).failures, 2);
});
test("unfinished AI requests pause with no automatic repeat; permanent access failures never retry", async () => {
  const o = owner(), j = await makeJob(o, false);
  await db.insert(ai).values({ jobId: j.id, callKey: "uncertain", status: "started" });
  let calls = 0;
  await runSlot(0, async (ctx) => { await ctx.ai("uncertain", async () => { calls++; return {}; }); }, o);
  assert.equal(calls, 0);
  assert.equal((await getJob(j.id)).status, "uncertain");
  await runSlot(1, async () => { calls++; }, o);
  assert.equal(calls, 0);
  const blocked = await makeJob(owner(), false);
  await runSlot(0, async () => { throw new Error("HTTP Error 403: private source; sign in required"); }, blocked.ownerId);
  assert.equal((await getJob(blocked.id)).status, "failed");
  assert.equal((await getJob(blocked.id)).failureKind, "permanent");
});
test("AI definite rate rejection honors Retry-After without treating it as uncertain billing", async () => {
  const o = owner(), j = await makeJob(o, false), until = new Date(Date.now() + 7200000);
  await runSlot(0, async () => { throw new AIRequestRejectedError("AI provider rejected request (HTTP 429).", 429, until); }, o);
  const saved = await getJob(j.id);
  assert.equal(saved.failureKind, "rate_limited");
  assert.equal(saved.retryAt!.toISOString(), until.toISOString());
  assert.equal(saved.status, "retry");
});
async function makePublish(o: string) {
  const j = await makeJob(o);
  const [clip] = await db.insert(clips).values({ ownerId: o, projectId: j.projectId, title: "Fixture", mode: "commentary", creator: "Fixture", duration: 35,
    score: 70, hookScore: 70, visualScore: 70, commentaryScore: 70, hook: "Fixture", script: "Fixture", hashtags: "", pinnedComment: "", demo: false, objectPath: "/objects/fixture" }).returning();
  const [a] = await db.insert(accounts).values({ ownerId: o, provider: "youtube", platform: "YouTube Shorts", remoteAccountId: randomUUID(), handle: "fixture", scopes: "", slots: [], approved: true, autoEnabled: true }).returning();
  const [w] = await db.insert(queue).values({ ownerId: o, accountId: a!.id, clipId: clip!.id, scheduledAt: new Date(0), timezone: "America/New_York" }).returning();
  return w!;
}
async function getPublish(id: number) { return (await db.select().from(queue).where(eq(queue.id, id)))[0]!; }
test("publisher healthy polling is not a failure; one rejected attempt retries; second is dead-lettered", async () => {
  const o = owner(), w = await makePublish(o);
  let polls = 0;
  const poll = async () => { polls++; await db.update(queue).set({ status: "processing", retryAt: null }).where(eq(queue.id, w.id)); };
  await publisherTick(() => false, poll, o);
  await publisherTick(() => false, poll, o);
  assert.equal(polls, 2);
  assert.equal((await getPublish(w.id)).attempts, 0);
  const until = new Date(Date.now() + 172800000); // never clamp a provider's longer restriction
  await publisherTick(() => false, async () => { throw new ProviderError(429, "Provider rate limit", until); }, o);
  let current = await getPublish(w.id);
  assert.equal(current.attempts, 1);
  assert.equal(current.status, "retry");
  assert.equal(current.retryAt!.toISOString(), until.toISOString());
  await publisherTick(() => false, async () => assert.fail("not due"), o);
  await db.update(queue).set({ retryAt: new Date(0) }).where(eq(queue.id, w.id));
  await Promise.all([publisherTick(() => false, async () => { throw new Error("Temporary storage failure"); }, o),
    publisherTick(() => false, async () => { throw new Error("Temporary storage failure"); }, o)]);
  current = await getPublish(w.id);
  assert.equal(current.status, "failed");
  assert.equal(current.attempts, 2);
});
test("a publishing failure does not stop another due entry", async () => {
  const o = owner(), first = await makePublish(o), second = await makePublish(o);
  let progressed = false;
  await publisherTick(() => false, async (work) => {
    if (work.id === first.id) throw new Error("Temporary download failure");
    assert.equal(work.id, second.id);
    progressed = true;
    await db.update(queue).set({ status: "published", remoteId: "fixture-confirmed" }).where(eq(queue.id, second.id));
  }, o);
  assert.equal(progressed, true);
  assert.equal((await getPublish(first.id)).status, "retry");
  assert.equal((await getPublish(second.id)).status, "published");
});
test("publisher ambiguous writes require reconciliation; consent and permanent restrictions never auto-repeat", async () => {
  for (const [error, expected] of [[new ReviewRequired("Review required"), "needs_review"],
    [new ReconciliationRequired("Outcome uncertain"), "reconciliation_required"], [new ProviderError(403, "Access forbidden"), "failed"]] as const) {
    const w = await makePublish(owner());
    await recordPublishFailure(w, error);
    assert.equal((await getPublish(w.id)).status, expected);
  }
  const w = await makePublish(owner());
  await db.update(queue).set({ checkpoint: { "effect:x-post": { state: "started" } } }).where(eq(queue.id, w.id));
  await recordPublishFailure(w, new Error("Network failure Bearer synthetic-credential"));
  const saved = await getPublish(w.id);
  assert.equal(saved.status, "reconciliation_required");
  assert.equal(saved.attempts, 0);
  assert.ok(!saved.error!.includes("synthetic-credential"));
  await publisherTick(() => false, async () => assert.fail("must not repeat uncertain write"), w.ownerId);
});
test("Retry-After supports seconds and dates; sanitization is shared and strips credential details", async () => {
  for (const after of ["7200", new Date(Date.now() + 7200000).toUTCString()]) {
    await assert.rejects(readJson(new Response('{"error":{"code":"rate_limit"}}', { status: 429, headers: { "retry-after": after } })),
      (error: unknown) => error instanceof ProviderError && error.notBefore!.getTime() > Date.now() + 7190000);
  }
  const message = redactError(new Error('Oops access_token="synthetic-a" api_key=synthetic-b Authorization: Bearer synthetic-c https://x.invalid/signed?sig=synthetic-d /tmp/secret-file'));
  assert.ok(!/synthetic-|secret-file/.test(message));
  assert.equal(nextFailure(1).status, "failed");
  // Additive migration is repeatable and never resets persistent failure counts.
  await pool.query(await readFile(new URL("../../../../lib/db/migrations/20261116_render_guardrails.sql", import.meta.url), "utf8"));
  assert.ok(Number((await pool.query("SELECT max(attempts) AS n FROM autopilot_publish_queue")).rows[0].n) >= 2);
});
test("budget API persists owner settings, rejects invalid/lower caps and protects uncertain and restricted manual repeats", async () => {
  const app = express(), o = owner(), other = owner();
  app.use(express.json());
  // Test-only middleware on an isolated local test server, never installed in the application.
  app.use((req, _res, next) => {
    req.workspaceId = req.header("x-fixture-owner") ?? o;
    req.isAuthenticated = (() => req.header("x-fixture-auth") !== "no") as typeof req.isAuthenticated;
    next();
  });
  app.use(autopilotRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (path: string, method = "GET", body?: unknown, scope = o, auth = "yes") => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json", "x-fixture-owner": scope, "x-fixture-auth": auth }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("/autopilot/render-budget", "GET", undefined, o, "no")).status, 401);
    const initial = GetRenderBudgetResponse.parse(await (await request("/autopilot/render-budget")).json());
    assert.equal(initial.dailyRenderCap, 15);
    assert.equal(initial.resetTimezone, "EST (fixed UTC-05:00)");
    assert.equal((await request("/autopilot/render-budget", "PATCH", { dailyRenderCap: 7 })).status, 200);
    assert.equal(GetRenderBudgetResponse.parse(await (await request("/autopilot/render-budget")).json()).dailyRenderCap, 7);
    assert.equal(GetRenderBudgetResponse.parse(await (await request("/autopilot/render-budget", "GET", undefined, other)).json()).dailyRenderCap, 15);
    for (const cap of [-1, 1.5, 1001, "abc"]) assert.equal((await request("/autopilot/render-budget", "PATCH", { dailyRenderCap: cap })).status, 400);
    const j = await makeJob(o);
    await reserveOutputs(o, j.id, 5, j.leaseToken!);
    assert.equal((await request("/autopilot/render-budget", "PATCH", { dailyRenderCap: 4 })).status, 409);
    const uncertain = await makeJob(o, false);
    await db.update(jobs).set({ status: "cancelled", cancelRequested: true }).where(eq(jobs.id, uncertain.id));
    await db.insert(ai).values({ jobId: uncertain.id, callKey: "ambiguous", status: "started" });
    assert.equal((await request(`/autopilot/jobs/${uncertain.id}/action`, "POST", { action: "retry" })).status, 409);
    assert.equal((await request(`/autopilot/jobs/${uncertain.id}/action`, "POST", { action: "acknowledge-uncertain" })).status, 200);
    assert.equal((await db.select().from(ai).where(eq(ai.jobId, uncertain.id))).length, 0);
    await db.update(jobs).set({ status: "failed", retryAt: new Date(Date.now() + 86400000) }).where(eq(jobs.id, uncertain.id));
    assert.equal((await request(`/autopilot/jobs/${uncertain.id}/action`, "POST", { action: "retry" })).status, 409);
    assert.equal((await request(`/autopilot/jobs/${uncertain.id}/action`, "POST", { action: "retry" }, other)).status, 404);
    const swarm = GetAutopilotSwarmResponse.parse(await (await request("/autopilot/swarm")).json());
    assert.equal(swarm.find((row) => row.id === uncertain.id)!.retryAt?.toISOString(), (await getJob(uncertain.id)).retryAt!.toISOString());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
