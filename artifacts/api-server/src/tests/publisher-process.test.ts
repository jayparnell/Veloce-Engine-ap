import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db, pool, projectsTable, generatedClipsTable, socialAccountsTable,
  socialConfigsTable, publishQueueTable,
} from "@workspace/db";
import { encryptTokens, PROVIDERS } from "../publishing/providers";

assert.notEqual(process.env.NODE_ENV, "production", "Development fixture only");
const owner = `user:publisher-process-test-${randomUUID()}`;
const children = new Set<ChildProcess>();
after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  }
  // Only rows owned by this random fixture identity; no real users or objects.
  try {
    await db.delete(socialAccountsTable).where(eq(socialAccountsTable.ownerId, owner));
    await db.delete(socialConfigsTable).where(eq(socialConfigsTable.ownerId, owner));
    await db.delete(projectsTable).where(eq(projectsTable.ownerId, owner));
  } finally { await pool.end(); }
});

async function seed() {
  const future = new Date("2099-01-01T00:00:00Z");
  const [project] = await db.insert(projectsTable).values({
    ownerId: owner, title: "Synthetic publisher interruption fixture",
    sourceUrl: "https://fixture.invalid/not-downloaded", mode: "commentary", status: "completed",
  }).returning();
  const [clip] = await db.insert(generatedClipsTable).values({
    ownerId: owner, projectId: project!.id, title: "Synthetic fixture", creator: "Synthetic",
    mode: "commentary", duration: 35, score: 0, hookScore: 0, visualScore: 0, commentaryScore: 0,
    hook: "Synthetic", script: "Synthetic", hashtags: "#Synthetic", pinnedComment: "Synthetic",
    objectPath: "/objects/fixture-never-read",
  }).returning();
  const [account] = await db.insert(socialAccountsTable).values({
    ownerId: owner, provider: "x", platform: "X", remoteAccountId: randomUUID(),
    handle: "Synthetic fixture", encryptedTokens: encryptTokens({ access_token: "synthetic-not-a-real-token" }),
    expiresAt: future, scopes: PROVIDERS.x.scopes, approved: true, connected: true,
    autoEnabled: true, autoEnabledAt: future, slots: ["12:00"],
  }).returning();
  await db.insert(socialConfigsTable).values({
    ownerId: owner, provider: "x", clientId: "synthetic-not-a-real-client", appApproved: true,
  }).onConflictDoNothing();
  const [work] = await db.insert(publishQueueTable).values({
    ownerId: owner, accountId: account!.id, clipId: clip!.id, scheduledAt: future,
    timezone: "America/New_York", status: "publishing",
    // Existing persisted media avoids any App Storage reads or paid generation.
    checkpoint: { xMediaId: "synthetic-media", xFinalized: true },
  }).returning();
  return work!.id;
}

function spawnWorker(id: number, origin: string, mode = "normal") {
  const child = fork(fileURLToPath(new URL("./fixtures/publisher-process.ts", import.meta.url)), [owner, String(id), origin, mode], {
    // Inherit the tsx loader, never the parent's --test runner.
    execArgv: process.execArgv.filter((arg) => arg !== "--test"),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.add(child);
  const messages: { type: string; port?: number }[] = [];
  child.on("message", (message) => messages.push(message as { type: string }));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  async function wait(type: string) {
    for (let n = 0; n < 1000; n++) {
      assert.ok(!messages.some((m) => m.type === "error"), "Fixture child failed");
      const result = messages.find((m) => m.type === type);
      if (result) return result;
      assert.equal(child.exitCode, null, "Fixture child exited unexpectedly");
      assert.equal(child.signalCode, null, "Fixture child was killed unexpectedly");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for fixture ${type}`);
  }
  return { child, wait, exited };
}

async function stored(id: number) {
  const [row] = await db.select().from(publishQueueTable)
    .where(and(eq(publishQueueTable.id, id), eq(publishQueueTable.ownerId, owner)));
  assert.ok(row);
  return row;
}

async function fakeProvider() {
  let posts = 0, hold = true;
  let pending: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    // Drain only synthetic request bytes. No credentials or content are logged.
    for await (const _part of req) { /* drain */ }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/2/tweets") {
      posts++;
      if (hold) { pending = res; return; }
      res.end(JSON.stringify({ data: { id: "synthetic-confirmed-post" } }));
    } else if (req.method === "GET" && req.url?.startsWith("/2/media/upload?")) {
      res.end(JSON.stringify({ data: { processing_info: { state: "succeeded" } } }));
    } else {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Unexpected fixture route" }));
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get posts() { return posts; },
    async accepted() {
      for (let n = 0; n < 1000 && posts === 0; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(posts, 1, "Fake provider must have accepted exactly one mutation");
    },
    release() {
      hold = false;
      pending?.end(JSON.stringify({ data: { id: "synthetic-confirmed-post" } }));
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test("SIGTERM drains the real publish request, retains its listener and reuses the completed checkpoint", { timeout: 30000 }, async () => {
  const id = await seed();
  const fake = await fakeProvider();
  const worker = spawnWorker(id, fake.origin);
  try {
    const { port } = await worker.wait("listening");
    await fake.accepted();
    assert.deepEqual((await stored(id)).checkpoint["effect:x-post"], { state: "started" });
    worker.child.kill("SIGTERM");
    await worker.wait("draining");
    const health = await fetch(`http://127.0.0.1:${port}/worker-healthz`);
    assert.equal(health.status, 503);
    assert.equal((await health.json() as { draining: boolean }).draining, true);
    const competitor = createServer();
    const bindFailure = once(competitor, "error");
    competitor.listen(port, "0.0.0.0");
    const [error] = await bindFailure;
    assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
    fake.release();
    assert.deepEqual(await worker.exited, { code: 0, signal: null });
    const saved = await stored(id);
    assert.equal(saved.status, "published");
    assert.equal(saved.remoteId, "synthetic-confirmed-post");
    assert.equal((saved.checkpoint["effect:x-post"] as { state: string }).state, "done");
    const resumed = spawnWorker(id, fake.origin);
    await resumed.wait("completed");
    resumed.child.kill("SIGTERM");
    assert.deepEqual(await resumed.exited, { code: 0, signal: null });
    assert.equal(fake.posts, 1, "A completed effect must not post again after process restart");
    const replacement = createServer().listen(port, "0.0.0.0");
    await once(replacement, "listening");
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  } finally { await fake.close(); }
});

test("SIGKILL after provider acceptance leaves a durable ambiguous checkpoint that cannot repeat", { timeout: 30000 }, async () => {
  const id = await seed();
  const fake = await fakeProvider();
  const worker = spawnWorker(id, fake.origin);
  try {
    await worker.wait("listening");
    await fake.accepted();
    worker.child.kill("SIGKILL");
    assert.deepEqual(await worker.exited, { code: null, signal: "SIGKILL" });
    assert.deepEqual((await stored(id)).checkpoint["effect:x-post"], { state: "started" });
    fake.release();
    const resumed = spawnWorker(id, fake.origin);
    await resumed.wait("reconciliation_required");
    resumed.child.kill("SIGTERM");
    assert.deepEqual(await resumed.exited, { code: 0, signal: null });
    const saved = await stored(id);
    assert.equal(saved.status, "reconciliation_required");
    assert.equal(saved.remoteId, null, "An unconfirmed post must not be marked published");
    assert.deepEqual(saved.checkpoint["effect:x-post"], { state: "started" });
    assert.equal(fake.posts, 1, "Restart must not repeat a mutation the provider may have accepted");
  } finally { await fake.close(); }
});

test("SIGKILL after a provider response but before checkpoint completion cannot repeat the post", { timeout: 30000 }, async () => {
  const id = await seed();
  const fake = await fakeProvider();
  const worker = spawnWorker(id, fake.origin, "after-response");
  try {
    await worker.wait("listening");
    await fake.accepted();
    fake.release();
    await worker.wait("response_received");
    worker.child.kill("SIGKILL");
    assert.deepEqual(await worker.exited, { code: null, signal: "SIGKILL" });
    assert.deepEqual((await stored(id)).checkpoint["effect:x-post"], { state: "started" });
    const resumed = spawnWorker(id, fake.origin);
    await resumed.wait("reconciliation_required");
    resumed.child.kill("SIGTERM");
    assert.deepEqual(await resumed.exited, { code: 0, signal: null });
    assert.equal(fake.posts, 1);
    assert.equal((await stored(id)).status, "reconciliation_required");
  } finally { await fake.close(); }
});

test("SIGKILL after checkpoint but before request is conservatively reconciled, not automatically posted", { timeout: 30000 }, async () => {
  const id = await seed();
  const fake = await fakeProvider();
  const worker = spawnWorker(id, fake.origin, "before-request");
  try {
    await worker.wait("listening");
    await worker.wait("before_request");
    assert.deepEqual((await stored(id)).checkpoint["effect:x-post"], { state: "started" });
    assert.equal(fake.posts, 0);
    worker.child.kill("SIGKILL");
    assert.deepEqual(await worker.exited, { code: null, signal: "SIGKILL" });
    const resumed = spawnWorker(id, fake.origin);
    await resumed.wait("reconciliation_required");
    resumed.child.kill("SIGTERM");
    assert.deepEqual(await resumed.exited, { code: 0, signal: null });
    assert.equal(fake.posts, 0, "Uncertain effects must not assume a provider request was never sent");
    assert.equal((await stored(id)).status, "reconciliation_required");
  } finally { await fake.close(); }
});
