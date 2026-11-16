import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, after } from "node:test";
import { db, pool, projectsTable, autopilotJobsTable as jobs, aiCheckpointsTable, socialAccountsTable, socialConfigsTable, generatedClipsTable, publishQueueTable, autopilotAdmissionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { runSlot, GLOBAL_SOURCE_LIMIT } from "../pipeline/worker";
import { JobContext, UncertainCallError, AIRequestRejectedError } from "../pipeline/job-context";
import { assignReadyClips } from "../publishing/allocator";
import { autopilotUsage } from "../lib/autopilotQuota";

const owner = `user:queue-test-${randomUUID()}`;
after(async () => {
  await db.delete(socialAccountsTable).where(eq(socialAccountsTable.ownerId, owner));
  await db.delete(socialConfigsTable).where(eq(socialConfigsTable.ownerId, owner));
  await db.delete(projectsTable).where(eq(projectsTable.ownerId, owner));
  await db.delete(autopilotAdmissionsTable).where(eq(autopilotAdmissionsTable.ownerId, owner));
  await pool.end();
});
async function createJob(requestKey = randomUUID()) {
  const [project] = await db.insert(projectsTable).values({ ownerId: owner, title: "Isolated verification fixture", sourceUrl: "https://youtu.be/fixture", mode: "commentary" }).returning();
  const [job] = await db.insert(jobs).values({ ownerId: owner, projectId: project!.id, requestKey, inputHash: "fixture" }).returning();
  await db.insert(autopilotAdmissionsTable).values({ ownerId: owner, requestKey, inputHash: "fixture", jobId: job!.id, projectId: project!.id });
  return job!;
}
test("actual PostgreSQL worker slots cap live jobs at five and recover checkpoints", async () => {
  const work = await Promise.all(Array.from({ length: 7 }, () => createJob()));
  let active = 0, maximum = 0;
  const runner = async (ctx: JobContext) => {
    active++; maximum = Math.max(maximum, active);
    await ctx.ai("fixture-analysis", async () => ({ text: "Saved evidence" }));
    await ctx.save("fixtureAsset", { objectPath: "/objects/synthetic-checkpoint" });
    await new Promise((r) => setTimeout(r, 100));
    active--;
  };
  await Promise.all(Array.from({ length: 10 }, (_, i) => runSlot(i % GLOBAL_SOURCE_LIMIT, runner, owner)));
  assert.equal(maximum, 5);
  const first = work.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)[0]!;
  await db.update(jobs).set({ status: "processing", leaseToken: "interrupted-fixture", leaseUntil: new Date(Date.now() - 10000) }).where(eq(jobs.id, first.id));
  // Ensure the interrupted source is selected before the remaining queued fixtures.
  let freshCalls = 0;
  await runSlot(0, async (ctx) => {
    assert.equal(ctx.job.id, first.id);
    const result = await ctx.ai("fixture-analysis", async () => { freshCalls++; return { text: "Unexpected repeat" }; });
    assert.equal(result.text, "Saved evidence");
    assert.equal((ctx.job.checkpoint.fixtureAsset as { objectPath: string }).objectPath, "/objects/synthetic-checkpoint");
  }, owner);
  assert.equal(freshCalls, 0, "restart must reuse successful AI work");
  await db.update(jobs).set({ status: "cancelled", cancelRequested: true }).where(and(eq(jobs.ownerId, owner), eq(jobs.status, "queued")));
});
test("ambiguous started AI calls pause without any provider repeat", async () => {
  const job = await createJob();
  await db.insert(aiCheckpointsTable).values({ jobId: job.id, callKey: "voice:0", status: "started" });
  let calls = 0;
  await runSlot(0, async (ctx) => {
    await assert.rejects(ctx.ai("voice:0", async () => { calls++; return { objectPath: "/objects/should-not-exist" }; }), UncertainCallError);
    // Let the worker classify the same uncertainty rather than hiding it.
    await ctx.ai("voice:0", async () => ({ objectPath: "/objects/should-not-exist" }));
  }, owner);
  const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(calls, 0); assert.equal(saved!.status, "uncertain");
});
test("cancellation stops at a checkpoint and preserves existing results", async () => {
  const job = await createJob();
  await runSlot(0, async (ctx) => {
    await ctx.save("completedAsset", "/objects/kept");
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, job.id));
    await ctx.check();
  }, owner);
  const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(saved!.status, "cancelled"); assert.equal(saved!.checkpoint.completedAsset, "/objects/kept");
});
test("definitive provider rejection permits deliberate retry without claiming a successful result", async () => {
  const job = await createJob();
  await runSlot(0, async (ctx) => {
    await assert.rejects(ctx.ai("rejected", async () => { throw Object.assign(new Error("fixture"), { status: 400 }); }), AIRequestRejectedError);
  }, owner);
  assert.equal((await db.select().from(aiCheckpointsTable).where(and(eq(aiCheckpointsTable.jobId, job.id), eq(aiCheckpointsTable.callKey, "rejected")))).length, 0);
});
test("a superseded worker token cannot save assets into the recovered job", async () => {
  const job = await createJob();
  await runSlot(0, async (ctx) => {
    await db.update(jobs).set({ leaseToken: "superseded-fixture", status: "completed" }).where(eq(jobs.id, job.id));
    await assert.rejects(ctx.save("mustNotPersist", "old worker output"));
  }, owner);
  const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.equal(saved!.checkpoint.mustNotPersist, undefined);
});
test("deleting source media cannot reset rolling daily usage", async () => {
  const job = await createJob();
  const before = await db.execute(autopilotUsage(owner));
  await db.delete(projectsTable).where(eq(projectsTable.id, job.projectId));
  const after = await db.execute(autopilotUsage(owner));
  assert.equal(Number(after.rows[0]!.daily), Number(before.rows[0]!.daily));
  assert.equal(Number(after.rows[0]!.active), Number(before.rows[0]!.active) - 1);
});
test("parallel allocators prevent collisions and duplicate account/clip assignments", async () => {
  const job = await createJob();
  await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id));
  const clipBase = { ownerId: owner, projectId: job.projectId, title: "Synthetic slot fixture", creator: "Fixture", mode: "commentary", duration: 35, score: 50, hookScore: 50, visualScore: 50, commentaryScore: 50, hook: "Fixture hook", script: "Fixture narration", hashtags: "", pinnedComment: "", objectPath: "/objects/not-real-test-fixture" };
  await db.insert(generatedClipsTable).values([{ ...clipBase, language: "en" }, { ...clipBase, language: "es" }]);
  await db.insert(socialConfigsTable).values({ ownerId: owner, provider: "youtube", clientId: "public-fixture", appApproved: true });
  await db.insert(socialAccountsTable).values([1, 2].map((n) => ({ ownerId: owner, provider: "youtube", platform: "YouTube Shorts", remoteAccountId: `fixture-${n}`, handle: `fixture-${n}`, scopes: "", encryptedTokens: "synthetic-not-a-credential", approved: true, autoEnabled: true, autoEnabledAt: new Date(0), includeDubs: n === 2, slots: ["12:30", "16:30", "20:30"] })));
  await Promise.all([assignReadyClips(owner), assignReadyClips(owner), assignReadyClips(owner)]);
  const entries = await db.select().from(publishQueueTable).where(eq(publishQueueTable.ownerId, owner));
  assert.equal(entries.length, 3, "English to both accounts; enabled Spanish only to second");
  assert.equal(new Set(entries.map((e) => `${e.accountId}:${e.scheduledAt.toISOString()}`)).size, 3);
  assert.equal(new Set(entries.map((e) => `${e.accountId}:${e.clipId}`)).size, 3);
  await db.insert(socialAccountsTable).values({ ownerId: owner, provider: "youtube", platform: "YouTube Shorts", remoteAccountId: "no-historical-backfill", handle: "fixture", scopes: "", approved: true, autoEnabled: true, autoEnabledAt: new Date(Date.now() + 60000), slots: ["12:30"] });
  await assignReadyClips(owner);
  assert.equal((await db.select().from(publishQueueTable).where(eq(publishQueueTable.ownerId, owner))).length, 3, "turning on automation cannot backfill historical clips");
});
