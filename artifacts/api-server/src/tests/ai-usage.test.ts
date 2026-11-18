import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, projectsTable, autopilotJobsTable as jobs, aiCheckpointsTable as calls,
  aiUsageTable as usage, autopilotAdmissionsTable as admissions, automationSettingsTable, type PoolClient } from "@workspace/db";
import { GetAutopilotUsageResponse } from "@workspace/api-zod";
import { captureManagedUsage, usageReport } from "../lib/ai-usage";
import { managedMetrics, addMetrics, unknownMetrics } from "../lib/ai-usage-metrics";
import { JobContext, JobStoppedError } from "../pipeline/job-context";
import { runSlot, adoptLegacyJobs } from "../pipeline/worker";
import autopilotRouter from "../routes/autopilot";
import { OpenAIRequestError } from "../lib/ai-client";
import { transcribeWords, wordTranscript } from "../pipeline/word-transcription";

// Isolated PostgreSQL schema; no actual provider calls or live queue fixtures.
const schema = `usage_${randomUUID().replaceAll("-", "")}`;
const owner = () => `usage-fixture:${randomUUID()}`;
const response = { usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
before(async () => {
  const c = await pool.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  (pool.options as { onConnect?: (c: PoolClient) => Promise<unknown> }).onConnect = client => client.query(`SET search_path TO "${schema}"`);
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
after(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
async function fixture(ownerId = owner(), language = "en") {
  const [p] = await db.insert(projectsTable).values({ ownerId, title: "Authorized usage fixture", sourceUrl: "https://youtu.be/fixture", mode: "commentary", demo: false }).returning();
  const [j] = await db.insert(jobs).values({ ownerId, projectId: p!.id, requestKey: randomUUID(), inputHash: "fixture",
    language, status: "processing", leaseToken: randomUUID() }).returning();
  await db.insert(admissions).values({ ownerId, projectId: p!.id, jobId: j!.id, requestKey: j!.requestKey, inputHash: "fixture" });
  return new JobContext(j!, j!.leaseToken!);
}
const recorded = async () => { await captureManagedUsage(response, "fixture-model"); return { text: "saved" }; };
test("successful results survive restart and same-key callers share work without billing checkpoints", async () => {
  const ctx = await fixture(); let invocations = 0;
  const fn = async () => { invocations++; return recorded(); };
  await Promise.all([ctx.ai("same", fn), ctx.ai("same", fn)]);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
  await new JobContext(row!, ctx.token).ai("same", fn);
  assert.equal(invocations, 1);
  assert.equal((await db.select().from(calls).where(eq(calls.jobId, ctx.job.id))).length, 0);
  assert.equal((await usageReport(ctx.job.ownerId)).entries[0]!.metrics.totalTokens, 130);
});
test("retired zero-unit caps and interrupted billing checkpoints never gate requests", async () => {
  const ctx = await fixture();
  await db.insert(automationSettingsTable).values({ ownerId: ctx.job.ownerId, dailyRequestUnitLimit: 0 });
  await db.insert(calls).values({ jobId: ctx.job.id, callKey: "legacy", status: "started" });
  await ctx.ai("legacy", recorded);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.dailyRequestUnitLimit, null); assert.equal(report.remainingUnits, null);
  assert.equal(report.entries[0]!.status, "done");
});
test("all final provider errors are persisted verbatim on jobs and projects with no additional worker retry", async () => {
  for (const [status, text] of [[400, "Invalid parameter"], [401, "Incorrect API key"], [429, "Insufficient quota"], [500, "Internal error"]] as const) {
    const ctx = await fixture();
    await db.update(jobs).set({ status: "queued", leaseToken: null }).where(eq(jobs.id, ctx.job.id));
    let invocations = 0;
    await runSlot(0, c => c.ai("request", async () => { invocations++; throw new OpenAIRequestError(Object.assign(new Error(text), { status })); }), ctx.job.ownerId);
    await runSlot(0, async () => { invocations++; }, ctx.job.ownerId);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, ctx.job.id));
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, ctx.job.projectId));
    assert.equal(row!.status, "failed"); assert.equal(row!.error, `${status} ${text}`);
    assert.equal(project!.error, row!.error); assert.equal(row!.retryAt, null);
    assert.equal(row!.failureKind, "openai_error"); assert.equal(invocations, 1);
    assert.equal((await usageReport(ctx.job.ownerId)).entries[0]!.status, "failed");
  }
});
test("retired AI hold states are recovered, without changing social-posting state", async () => {
  for (const state of ["uncertain", "budget_paused"]) {
    const ctx = await fixture();
    await db.update(jobs).set({ status: state, failureKind: "ai_usage_cap", leaseToken: null }).where(eq(jobs.id, ctx.job.id));
    await adoptLegacyJobs();
    await runSlot(0, c => c.ai("resume", recorded).then(() => {}), ctx.job.ownerId);
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, ctx.job.id)))[0]!.status, "completed");
  }
});
test("successful ASR responses with unusable timestamps can still use reusable CPU alignment", async () => {
  const ctx = await fixture(); let remote = 0, local = 0;
  const services = {
    remote: async () => { remote++; await captureManagedUsage({ duration: 2 }, "whisper-1"); return wordTranscript({}, 2, "fixture"); },
    local: async () => { local++; return wordTranscript({ words: [{ word: "fixture", start: .123, end: 1 }] }, 2, "local"); },
  };
  await transcribeWords("synthetic", 2, ctx, "asr", services);
  await transcribeWords("synthetic", 2, ctx, "asr", services);
  assert.equal(remote, 1); assert.equal(local, 1);
});
test("parallel stages retain separate metrics; unknown values never invent billing", async () => {
  const ctx = await fixture(), es = await fixture(ctx.job.ownerId, "es");
  await Promise.all([ctx.ai("voice:0", recorded), es.ai("translation", recorded)]);
  const report = await usageReport(ctx.job.ownerId);
  assert.equal(report.usedUnits, 2); assert.equal(report.groups[1]!.metrics.totalTokens, 130);
  assert.equal(report.groups[2]!.metrics.totalTokens, 130);
  assert.equal(managedMetrics({ duration: 2 }).audioSeconds, 2);
  assert.deepEqual(managedMetrics({ usage: { total_tokens: "bad" } }), unknownMetrics());
  assert.deepEqual(addMetrics(unknownMetrics(), unknownMetrics()), unknownMetrics());
});
test("lease fencing and cancellation remain intact without billing state", async () => {
  const ctx = await fixture();
  await assert.rejects(ctx.ai("voice:0", async () => {
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, ctx.job.id));
    return recorded();
  }), JobStoppedError);
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, ctx.job.id)))[0]!.checkpoint["ai-result:voice:0"] != null, true);
  await assert.rejects(ctx.ai("voice:1", recorded), JobStoppedError);
});
test("owner-scoped usage and job endpoints expose raw diagnostics and retire billing controls", async () => {
  const ctx = await fixture(), o = ctx.job.ownerId, other = owner();
  const diagnostic = "429 Insufficient quota. See https://platform.openai.com/docs/guides/error-codes/api-errors";
  await db.update(jobs).set({ status: "failed", error: diagnostic, failureKind: "openai_error", leaseToken: null }).where(eq(jobs.id, ctx.job.id));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = req.header("x-owner") ?? o;
    req.isAuthenticated = (() => req.header("x-auth") !== "no") as typeof req.isAuthenticated; next();
  });
  app.use(autopilotRouter);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, scope = o, auth = "yes", method = "GET", body?: unknown) => fetch(`${url}${path}`, {
    method, headers: { "content-type": "application/json", "x-owner": scope, "x-auth": auth }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("/autopilot/usage", o, "no")).status, 401);
    assert.equal((await request("/autopilot/usage", o, "yes", "PATCH", { dailyRequestUnitLimit: 0 })).status, 410);
    const swarm = await (await request("/autopilot/swarm")).json();
    assert.match(JSON.stringify(swarm), /429 Insufficient quota/);
    assert.ok(JSON.stringify(swarm).includes(diagnostic), "API must not re-mask the provider message or documentation URL");
    assert.doesNotMatch(JSON.stringify(await (await request("/autopilot/swarm", other)).json()), /429 Insufficient quota/);
    await db.insert(usage).values(Array.from({ length: 105 }, (_, i) => ({ ownerId: o, jobId: ctx.job.id, projectId: ctx.job.projectId,
      sourceTitle: "Paged fixture", language: "en", category: "source", callKey: `fixture:${i}`, status: "done" })));
    const report = GetAutopilotUsageResponse.parse(await (await request("/autopilot/usage")).json());
    const next = GetAutopilotUsageResponse.parse(await (await request(`/autopilot/usage?before=${report.nextBefore}`)).json());
    assert.equal(report.entries.length, 100); assert.equal(next.entries.length, 5);
    assert.equal(GetAutopilotUsageResponse.parse(await (await request("/autopilot/usage", other)).json()).entries.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
