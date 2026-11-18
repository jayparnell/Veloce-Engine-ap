import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, projectsTable, autopilotJobsTable as jobs, aiCheckpointsTable as calls,
  aiUsageTable as usage, autopilotAdmissionsTable as admissions, type PoolClient } from "@workspace/db";
import { GetAutopilotUsageResponse } from "@workspace/api-zod";
import { captureManagedUsage, setUsageLimit, usageReport, AIUsagePaused } from "../lib/ai-usage";
import { managedMetrics, addMetrics, unknownMetrics } from "../lib/ai-usage-metrics";
import { JobContext, UncertainCallError, AIRequestRejectedError, JobStoppedError } from "../pipeline/job-context";
import { runSlot, adoptLegacyJobs } from "../pipeline/worker";
import autopilotRouter from "../routes/autopilot";
import { AIRetryScheduled, AIRetriesExhausted, attemptKey, requestKey, retryDate } from "../pipeline/ai-retry";
import { aiUsageContext } from "../lib/ai-usage";
import { transcribeWords, wordTranscript } from "../pipeline/word-transcription";

// No provider calls, external writes, or live queue fixtures.
const schema = `usage_${randomUUID().replaceAll("-", "")}`;
const migration = new URL("../../../../lib/db/migrations/20261116_ai_usage.sql", import.meta.url);
const owner = () => `usage-fixture:${randomUUID()}`;
const response = { usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
  prompt_tokens_details: { audio_tokens: 40 }, completion_tokens_details: { audio_tokens: 20 } } };
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
    for (const file of ["20261116_autopilot.sql", "20261116_render_guardrails.sql", "20261116_ai_usage.sql", "20261117_unified_posting.sql"]) {
      await c.query(await readFile(new URL(`../../../../lib/db/migrations/${file}`, import.meta.url), "utf8"));
    }
  } finally { c.release(); }
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
async function fixture(ownerId = owner(), language = "en") {
  const [p] = await db.insert(projectsTable).values({ ownerId, title: "Authorized usage fixture", sourceUrl: "https://youtu.be/fixture", mode: "commentary", demo: false }).returning();
  const [j] = await db.insert(jobs).values({ ownerId, projectId: p!.id, requestKey: randomUUID(), inputHash: "fixture",
    language, status: "processing", leaseToken: randomUUID() }).returning();
  await db.insert(admissions).values({ ownerId, projectId: p!.id, jobId: j!.id, requestKey: j!.requestKey, inputHash: "fixture" });
  return new JobContext(j!, j!.leaseToken!);
}
const recorded = async () => { await captureManagedUsage(response, "fixture-managed-model"); return { text: "saved" }; };

test("automatic AI retries survive new worker contexts, stop after three repeats and preserve every receipt", async () => {
  let ctx = await fixture();
  const keys: string[] = [];
  let attempts = 0;
  await ctx.ai("saved-analysis", recorded);
  for (let n = 1; n <= 4; n++) {
    const failed = ctx.ai("voice:auto", async () => {
      attempts++; keys.push(aiUsageContext.getStore()!.requestKey!);
      throw new Error("synthetic connection timeout");
    });
    await assert.rejects(failed, n < 4 ? AIRetryScheduled : AIRetriesExhausted);
    if (n < 4) {
      await assert.rejects(ctx.ai("voice:auto", async () => assert.fail("backoff must block an early repeat")), AIRetryScheduled);
      // Advance just the fixture's persisted eligibility, never wall-clock sleeps or real providers.
      await ctx.save(attemptKey("voice:auto"), { attempt: n, retryAt: "2000-01-01T00:00:00.000Z" });
      const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
      ctx = new JobContext(row!, ctx.token);
    }
  }
  await assert.rejects(ctx.ai("voice:auto", async () => assert.fail("exhausted calls must not run")), AIRetriesExhausted);
  await ctx.ai("saved-analysis", async () => assert.fail("completed stages must remain reusable"));
  assert.equal(attempts, 4);
  assert.equal(new Set(keys).size, 1);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 5);
  assert.equal(report.entries.filter(e => e.status === "uncertain").length, 4);
});
test("concurrent callers for the same AI checkpoint share one request", async () => {
  const ctx = await fixture(); let calls = 0;
  const fn = async () => { calls++; return recorded(); };
  const results = await Promise.all([ctx.ai("same", fn), ctx.ai("same", fn)]);
  assert.deepEqual(results[0], results[1]); assert.equal(calls, 1);
});
test("AI Retry-After is durable and workers do not wait for manual approval", async () => {
  const ctx = await fixture();
  await db.update(jobs).set({ status: "queued", leaseToken: null }).where(eq(jobs.id, ctx.job.id));
  let calls = 0; const before = Date.now();
  await runSlot(0, async c => { await c.ai("rate", async () => {
    calls++; throw Object.assign(new Error("synthetic limit"), { status: 429, headers: new Headers({ "retry-after": "90" }) });
  }); }, ctx.job.ownerId);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
  assert.equal(row!.status, "retry"); assert.equal(row!.failureKind, "ai_retry");
  assert.ok(row!.retryAt!.getTime() >= before + 90000);
  await runSlot(0, async () => { calls++; }, ctx.job.ownerId);
  assert.equal(calls, 1);
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 0);
});
test("a completed CPU transcription fallback stays reusable after a deliberate retry", async () => {
  let ctx = await fixture(), remote = 0, local = 0;
  const services = {
    remote: async () => { remote++; throw Object.assign(new Error("unsupported fixture"), { status: 404 }); },
    local: async () => { local++; return wordTranscript({ words: [{ word: "fixture", start: .123, end: 1.123 }] }, 2, "synthetic-local"); },
  };
  await transcribeWords("synthetic", 2, ctx, "asr", services);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
  const checkpoint = Object.fromEntries(Object.entries(row!.checkpoint).filter(([k]) => !k.startsWith("ai-attempt:")));
  await db.update(jobs).set({ checkpoint }).where(eq(jobs.id, ctx.job.id));
  ctx = new JobContext({ ...row!, checkpoint }, ctx.token);
  const result = await transcribeWords("synthetic", 2, ctx, "asr", services);
  assert.equal(result.words[0]!.start, .123);
  assert.equal(remote, 1); assert.equal(local, 1);
  assert.equal((await usageReport(ctx.job.ownerId)).entries.length, 2);
});
test("invalid timestamps from a successful API response fall back once without repeating the paid call", async () => {
  const ctx = await fixture(); let remote = 0;
  const result = await transcribeWords("synthetic", 2, ctx, "invalid-format", {
    remote: async () => { remote++; await captureManagedUsage({ duration: 2 }, "whisper-1"); return wordTranscript({}, 2, "invalid"); },
    local: async () => wordTranscript({ words: [{ word: "fixture", start: 0, end: 1 }] }, 2, "synthetic-local"),
  });
  assert.equal(remote, 1); assert.equal(result.provider, "synthetic-local");
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.entries.find(e => e.model === "whisper-1")!.status, "done");
  assert.equal(report.entries.find(e => e.model === "whisper-1")!.metrics.audioSeconds, 2);
});
test("historical AI approval holds automatically resume with no provider side effects in the fixture", async () => {
  const ctx = await fixture();
  await db.insert(calls).values({ jobId: ctx.job.id, callKey: "legacy", status: "started" });
  await db.update(jobs).set({ status: "uncertain", leaseToken: null, leaseUntil: null }).where(eq(jobs.id, ctx.job.id));
  await adoptLegacyJobs();
  let invocations = 0;
  await runSlot(0, async c => { await c.ai("legacy", async () => { invocations++; return { text: "synthetic recovery" }; }); }, ctx.job.ownerId);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
  assert.equal(row!.status, "completed"); assert.equal(invocations, 1);
});

test("normalizes chat, transcription tokens and seconds without inventing usage or summing subsets", () => {
  const chat = managedMetrics(response);
  assert.equal(chat.totalTokens, 130);
  assert.equal(chat.inputAudioTokens, 40);
  assert.equal(chat.outputAudioTokens, 20);
  assert.equal(managedMetrics({ usage: { type: "duration", seconds: 12.5 } }).audioSeconds, 12.5);
  assert.equal(managedMetrics({ usage: { input_tokens: 6, input_token_details: { audio_tokens: 4 }, output_tokens: 2, total_tokens: 8 } }).inputAudioTokens, 4);
  assert.deepEqual(managedMetrics({ usage: { total_tokens: "10", prompt_tokens: -1, completion_tokens: Infinity } }), unknownMetrics());
  assert.deepEqual(addMetrics(unknownMetrics(), unknownMetrics()), unknownMetrics());
  assert.equal(addMetrics(chat, chat).totalTokens, 260);
});
test("successful checkpoints store metrics once and reuse without charging units or calling again", async () => {
  const ctx = await fixture();
  let invocations = 0;
  const fn = async () => { invocations++; return recorded(); };
  assert.deepEqual(await ctx.ai("moment-plan", fn), { text: "saved" });
  await ctx.ai("moment-plan", fn);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(invocations, 1);
  assert.equal(report.usedUnits, 1);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]!.metrics.totalTokens, 130);
  assert.equal(report.groups[0]!.metrics.totalTokens, 130);
  assert.equal(report.dailyJobs, 1);
  assert.equal(report.remainingDailyJobs, 19);
  assert.equal(report.remainingActiveJobs, 9);
});
test("concurrent stages retain their own metrics and separate source, narration, ES and PT", async () => {
  const ctx = await fixture(), es = await fixture(ctx.job.ownerId, "es"), pt = await fixture(ctx.job.ownerId, "pt");
  await Promise.all([ctx.ai("transcribe:0", async () => {
    await captureManagedUsage({ usage: { seconds: 120 } }, "fixture-transcribe"); return { text: "audio" };
  }), ctx.ai("voice:0", recorded), es.ai("translation", recorded), pt.ai("voice:0", recorded)]);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 4);
  assert.deepEqual(report.groups.map((g) => [g.category, g.units]), [["source", 1], ["narration", 1], ["es", 1], ["pt", 1]]);
  assert.equal(report.groups[0]!.metrics.audioSeconds, 120);
  assert.equal(report.groups[0]!.metrics.totalTokens, null);
  assert.equal(report.groups[1]!.metrics.audioSeconds, null);
});
test("unreported and invalid responses remain explicit; metrics survive post-response failures", async () => {
  const ctx = await fixture();
  await ctx.ai("voice:0", async () => ({ transcript: "unknown metrics" }));
  await assert.rejects(ctx.ai("moment-plan", async () => {
    await recorded();
    // Storage failure with a 403 must not be mistaken for a provider rejection.
    throw Object.assign(new Error("storage failed"), { status: 403 });
  }), UncertainCallError);
  await assert.rejects(ctx.ai("moment-plan", recorded), UncertainCallError);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 2);
  assert.equal(report.entries[0]!.status, "done");
  assert.equal(report.entries[0]!.metrics.totalTokens, 130);
  assert.equal(report.groups[1]!.unknown, 1);
  assert.equal(report.groups[1]!.metrics.totalTokens, null);
});
test("parallel admissions cannot exceed a cap, cap zero pauses, and saved results remain reusable", async () => {
  const ctx = await fixture();
  await setUsageLimit(ctx.job.ownerId, 1);
  const attempts = await Promise.allSettled([ctx.ai("transcribe:0", recorded), ctx.ai("transcribe:120", recorded)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((r) => r.status === "rejected" && r.reason instanceof AIUsagePaused).length, 1);
  let report = await setUsageLimit(ctx.job.ownerId, 0);
  assert.equal(report.usedUnits, 1);
  assert.equal(report.remainingUnits, 0);
  await ctx.ai(report.entries[0]!.callKey, recorded);
  await assert.rejects(ctx.ai("voice:0", recorded), AIUsagePaused);
  assert.equal((await db.select().from(calls).where(eq(calls.jobId, ctx.job.id))).length, 1, "paused stages leave no ambiguous checkpoints");
  report = await setUsageLimit(ctx.job.ownerId, null);
  assert.equal(report.remainingUnits, null);
  await ctx.ai("voice:0", recorded);
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 2);
});
test("definitive rejections retain a zero-unit receipt and deliberate retries get a new attempt", async () => {
  const ctx = await fixture();
  await assert.rejects(ctx.ai("moment-plan", async () => { throw Object.assign(new Error("rejected"), { status: 429 }); }), AIRetryScheduled);
  let report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 0);
  assert.equal(report.entries[0]!.status, "rejected");
  await db.update(jobs).set({ checkpoint: {} }).where(eq(jobs.id, ctx.job.id)); // Explicit fresh retry, without waiting in the fixture.
  await ctx.ai("moment-plan", recorded);
  report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 1);
  assert.equal(report.entries.length, 2);
});
test("lease fences stop new admissions; completed calls still persist when cancellation arrives", async () => {
  const ctx = await fixture();
  await ctx.ai("voice:0", async () => {
    await recorded();
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, ctx.job.id));
    return { audio: "saved" };
  }).then(() => assert.fail("cancellation should stop work"), (e) => assert.ok(e instanceof JobStoppedError));
  assert.equal((await usageReport(ctx.job.ownerId)).entries[0]!.status, "done");
  await assert.rejects(ctx.ai("voice:1", recorded), JobStoppedError);
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 1);
});
test("unit receipts and durable daily job counts survive source deletion", async () => {
  const ctx = await fixture();
  await ctx.ai("moment-plan", recorded);
  await db.delete(projectsTable).where(eq(projectsTable.id, ctx.job.projectId));
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 1);
  assert.equal(report.dailyJobs, 1);
  assert.equal(report.activeJobs, 0);
  assert.equal(report.entries[0]!.sourceTitle, "Authorized usage fixture");
});
test("rolling allowance expires, but unresolved in-flight calls stay reserved", async () => {
  const ctx = await fixture();
  await ctx.ai("moment-plan", recorded);
  await db.update(usage).set({ createdAt: new Date(Date.now() - 25 * 3600000) }).where(eq(usage.jobId, ctx.job.id));
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 0);
  await db.update(usage).set({ status: "started" }).where(eq(usage.jobId, ctx.job.id));
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 1);
  await setUsageLimit(ctx.job.ownerId, 1);
  await assert.rejects(ctx.ai("voice:0", recorded), AIUsagePaused);
});
test("worker pauses on usage caps without failures and resumes after the owner raises the cap", async () => {
  const ctx = await fixture();
  await db.update(jobs).set({ status: "queued", leaseToken: null }).where(eq(jobs.id, ctx.job.id));
  await setUsageLimit(ctx.job.ownerId, 0);
  await runSlot(0, async (c) => { await c.ai("moment-plan", recorded); }, ctx.job.ownerId);
  const [paused] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
  assert.equal(paused!.status, "budget_paused");
  assert.equal(paused!.failureKind, "ai_usage_cap");
  assert.equal(paused!.failures, 0);
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 0);
  await setUsageLimit(ctx.job.ownerId, 1);
  await runSlot(0, async (c) => { await c.ai("moment-plan", recorded); }, ctx.job.ownerId);
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, ctx.job.id)))[0]!.status, "completed");
  assert.equal((await usageReport(ctx.job.ownerId)).usedUnits, 1);
});
test("repeatable migration backfills legacy checkpoints as unknown once", async () => {
  const ctx = await fixture();
  await db.insert(calls).values([{ jobId: ctx.job.id, callKey: "voice:0", status: "done", result: { text: "legacy" } },
    { jobId: ctx.job.id, callKey: "moment-plan", status: "started" }]);
  await pool.query(await readFile(migration, "utf8"));
  await pool.query(await readFile(migration, "utf8"));
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.entries.length, 2);
  assert.equal(report.groups.reduce((n, g) => n + g.unknown, 0), 2);
  assert.equal(report.entries.find((e) => e.callKey === "moment-plan")!.status, "uncertain");
});
test("private API validates caps, pages history, and retains acknowledged uncertain attempts", async () => {
  const ctx = await fixture(), o = ctx.job.ownerId, other = owner();
  await assert.rejects(ctx.ai("moment-plan", async () => { throw new Error("timeout"); }), UncertainCallError);
  await db.update(jobs).set({ status: "uncertain", leaseUntil: null }).where(eq(jobs.id, ctx.job.id));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = req.header("x-owner") ?? o;
    req.isAuthenticated = (() => req.header("x-auth") !== "no") as typeof req.isAuthenticated;
    next();
  });
  app.use(autopilotRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const request = (path: string, method = "GET", body?: unknown, scope = o, auth = "yes") => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-owner": scope, "x-auth": auth }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("/autopilot/usage", "GET", undefined, o, "no")).status, 401);
    assert.equal((await request("/autopilot/usage", "PATCH", { dailyRequestUnitLimit: 0 }, o, "no")).status, 401);
    for (const value of [-1, 1.5, 10001, "3", false]) assert.equal((await request("/autopilot/usage", "PATCH", { dailyRequestUnitLimit: value })).status, 400);
    assert.equal((await request("/autopilot/usage", "PATCH", {})).status, 400);
    assert.equal((await request("/autopilot/usage?before=-1")).status, 400);
    for (const cap of [0, 5, null]) {
      const result = await request("/autopilot/usage", "PATCH", { dailyRequestUnitLimit: cap });
      assert.equal(result.status, 200);
      assert.equal(GetAutopilotUsageResponse.parse(await result.json()).dailyRequestUnitLimit, cap);
    }
    assert.equal((await request(`/autopilot/jobs/${ctx.job.id}/action`, "POST", { action: "acknowledge-uncertain" }, other)).status, 404);
    assert.equal((await request(`/autopilot/jobs/${ctx.job.id}/action`, "POST", { action: "acknowledge-uncertain" })).status, 200);
    await db.update(jobs).set({ status: "processing", leaseToken: ctx.token }).where(eq(jobs.id, ctx.job.id));
    await ctx.ai("moment-plan", recorded);
    let report = GetAutopilotUsageResponse.parse(await (await request("/autopilot/usage")).json());
    assert.equal(report.usedUnits, 2);
    assert.equal(report.entries.filter((e) => e.status === "uncertain").length, 1);
    const privateReport = GetAutopilotUsageResponse.parse(await (await request("/autopilot/usage", "GET", undefined, other)).json());
    assert.equal(privateReport.entries.length, 0);
    assert.equal(privateReport.dailyRequestUnitLimit, null);
    // Generate only local receipts to verify cursor boundaries without a provider request.
    await db.insert(usage).values(Array.from({ length: 105 }, (_, i) => ({ ownerId: o, jobId: ctx.job.id, projectId: ctx.job.projectId,
      sourceTitle: "Paged fixture", language: "en", category: "source", callKey: `fixture:${i}`, status: "done" })));
    report = GetAutopilotUsageResponse.parse(await (await request("/autopilot/usage")).json());
    assert.equal(report.entries.length, 100);
    assert.ok(report.nextBefore);
    const next = GetAutopilotUsageResponse.parse(await (await request(`/autopilot/usage?before=${report.nextBefore}`)).json());
    assert.equal(next.entries.length, 7);
    assert.equal(next.nextBefore, null);
    assert.equal(new Set([...report.entries, ...next.entries].map((e) => e.id)).size, 107);
    assert.equal(next.usedUnits, report.usedUnits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
