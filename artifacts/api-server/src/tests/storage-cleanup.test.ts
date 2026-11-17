import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import express from "express";
import { db, pool, projectsTable, generatedClipsTable, autopilotJobsTable, aiCheckpointsTable,
  storageCleanupsTable, type PoolClient } from "@workspace/db";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { assessObject, collectObjectPaths, type InventoryObject } from "../lib/storage-retention";
import { cleanupServices, storageReport as indexedStorageReport, confirmCleanup, cleanupHistory, cleanupDetail, CleanupConflict } from "../lib/storage-cleanup";
import { inventoryServices, inventoryMetadata, bucketLocation } from "../lib/storage-index";
import cleanupRouter from "../routes/storage-cleanup";
import { buildExport } from "../pipeline/export";
import { JobContext } from "../pipeline/job-context";
import type { ownedFile } from "../lib/mediaStorage";

const schema = `retention_${randomUUID().replaceAll("-", "")}`;
const owner = `user:${randomUUID()}`;
const media = new Map<string, InventoryObject>();
const bytes = new Map<string, Buffer>();
const originals = { ...cleanupServices };
const originalPage = inventoryServices.page;
const policy = { exportDays: 7, intermediateDays: 7 };
let base = "";
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.workspaceId = String(req.headers["x-owner"] ?? owner);
  req.isAuthenticated = (() => req.headers["x-auth"] !== "no") as typeof req.isAuthenticated;
  next();
});
app.use(cleanupRouter);
const server = createServer(app);

function object(name: string, contentType = "audio/mpeg", overrides: Partial<InventoryObject> = {}) {
  const item: InventoryObject = { objectPath: `/objects/${name}`, owner, private: true, contentType,
    purpose: "intermediate", bytes: 20, createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    generation: "12345678901234567", metageneration: "2", ...overrides };
  media.set(item.objectPath, item);
  bytes.set(item.objectPath, Buffer.from(`fixture-${name}`));
  return item;
}
before(async () => {
  const c = await pool.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  (pool.options as { onConnect?: (client: PoolClient) => Promise<unknown> }).onConnect =
    (client) => client.query(`SET search_path TO "${schema}"`);
  try {
    await c.query(`SET search_path TO "${schema}"`);
    for (const table of ["projects", "generated_clips", "source_videos", "monetization_campaigns", "media_uploads",
      "autopilot_jobs", "autopilot_ai_calls", "autopilot_publish_queue"]) {
      await c.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      if (!["media_uploads", "autopilot_ai_calls"].includes(table)) {
        await c.query(`CREATE SEQUENCE ${table}_fixture_id`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_id')`);
      }
    }
    await c.query(await readFile(new URL("../../../../lib/db/migrations/20261116_storage_cleanup.sql", import.meta.url), "utf8"));
    await c.query(await readFile(new URL("../../../../lib/db/migrations/20261117_storage_index.sql", import.meta.url), "utf8"));
  } finally { c.release(); }
  inventoryServices.page = async () => ({ objects: [...media.values()].map((item) => ({ ...item })), nextToken: null });
  cleanupServices.current = async (path) => {
    const item = media.get(path);
    if (!item) throw new Error("Not found");
    return { ...item };
  };
  cleanupServices.remove = async (item) => {
    assert.equal(media.get(item.objectPath)?.generation, item.generation);
    assert.equal(media.get(item.objectPath)?.metageneration, item.metageneration);
    media.delete(item.objectPath); bytes.delete(item.objectPath);
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  Object.assign(cleanupServices, originals);
  inventoryServices.page = originalPage;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
async function project(own = owner) {
  const [p] = await db.insert(projectsTable).values({ ownerId: own, title: "Storage fixture", sourceUrl: "https://example.invalid/fixture", mode: "commentary" }).returning();
  return p!;
}
async function storageReport(own: string, retention?: typeof policy, persist = false, cursor = "", limit = 50) {
  await pool.query("UPDATE storage_inventory_state SET advanced_at=NULL");
  return indexedStorageReport(own, retention, persist, cursor, limit);
}
async function execute(report: Awaited<ReturnType<typeof storageReport>>, own = owner) {
  const candidates = report.objects.filter((item) => item.eligible);
  return confirmCleanup(own, report.reportId, candidates.map((item) => item.objectPath), `DELETE ${candidates.length} OBJECTS`);
}

test("recursive references cover media URLs, recipes, arrays, AI results and nested checkpoints", () => {
  assert.deepEqual([...collectObjectPaths({ a: "/api/storage/objects/voice", b: [{ recipe: { source: { objectPath: "/objects/source" } } }],
    c: { fitted: "/objects/fitted", captions: "/objects/captions", poster: "/objects/poster" } })].sort(),
  ["/objects/captions", "/objects/fitted", "/objects/poster", "/objects/source", "/objects/voice"]);
});
test("safe defaults protect MP4s, unknown objects, uploads, references, young and foreign media", () => {
  const refs = new Set(["/objects/ref"]);
  for (const item of [
    object("upload", "audio/mpeg", { objectPath: "/objects/uploads/upload" }),
    object("playable", "video/mp4"), object("ref"), object("legacy", "audio/mpeg", { purpose: "" }),
    object("young", "audio/mpeg", { createdAt: new Date().toISOString() }),
  ]) assert.equal(assessObject(item, owner, refs, new Set(), false, policy)?.eligible, false);
  assert.equal(assessObject(object("foreign", "application/zip", { owner: "someone-else" }), owner, refs, new Set(), false, policy), null);
  assert.equal(assessObject(object("public", "application/zip", { private: false }), owner, refs, new Set(), false, policy), null);
  const orphan = object("orphan-default");
  assert.equal(assessObject(orphan, owner, refs, new Set(), false, { exportDays: null, intermediateDays: null })?.eligible, false);
  assert.equal(assessObject(orphan, owner, refs, new Set(), true, policy)?.eligible, false);
  assert.equal(assessObject(orphan, owner, refs, new Set(), false, policy)?.eligible, true);
  media.clear(); bytes.clear();
});
test("owner totals, exact confirmation, expiry, repeat prevention and durable outcomes", async () => {
  object("stale-pack", "application/zip");
  object("orphan-voice");
  object("uploads/source", "video/mp4");
  object("other-pack", "application/zip", { owner: "someone-else" });
  const defaults = await storageReport(owner);
  assert.equal(defaults.objects.length, 3);
  assert.equal(defaults.objects.filter((item) => item.eligible).length, 0);
  assert.equal(defaults.totals.reduce((sum, item) => sum + item.bytes, 0), 60);
  const report = await storageReport(owner, policy, true);
  assert.equal(report.objects.filter((item) => item.eligible).length, 2);
  await assert.rejects(() => execute(report, "other-owner"), CleanupConflict);
  await assert.rejects(() => confirmCleanup(owner, report.reportId, ["/objects/stale-pack"], "DELETE 2 OBJECTS"), CleanupConflict);
  await assert.rejects(() => confirmCleanup(owner, report.reportId, ["/objects/stale-pack", "/objects/orphan-voice"], "yes"), CleanupConflict);
  const result = await execute(report);
  assert.equal(result.status, "completed");
  assert.equal(result.objects.filter((item) => item.outcome === "deleted").length, 2);
  assert.ok(media.has("/objects/uploads/source"));
  assert.ok(media.has("/objects/other-pack"));
  await assert.rejects(() => execute(report), CleanupConflict);
  const history = await cleanupHistory(owner);
  assert.equal(history.items[0]?.status, "completed");
  assert.equal((await cleanupHistory("other-owner")).items.length, 0);
  const [saved] = await db.select().from(storageCleanupsTable).where(eq(storageCleanupsTable.id, report.reportId));
  assert.deepEqual(saved!.report, report, "Confirmation never rewrites the original manifest");
  assert.equal((await cleanupDetail(owner, report.reportId))?.objects[0]?.outcome, "deleted");
  object("expiry-pack", "application/zip");
  const expired = await storageReport(owner, policy, true);
  expired.expiresAt = new Date(0).toISOString();
  await db.update(storageCleanupsTable).set({ report: expired }).where(eq(storageCleanupsTable.id, expired.reportId));
  await assert.rejects(() => execute(expired), CleanupConflict);
});
test("live references, changed ownership and generations are rechecked; failure never replays", async () => {
  const p = await project();
  object("new-reference");
  object("changed-generation");
  object("changed-owner");
  object("delete-error");
  const report = await storageReport(owner, policy, true);
  await db.update(projectsTable).set({ sourceUrl: "/objects/new-reference" }).where(eq(projectsTable.id, p.id));
  media.get("/objects/changed-generation")!.generation = "999";
  media.get("/objects/changed-owner")!.owner = "other-owner";
  const remove = cleanupServices.remove;
  cleanupServices.remove = async (item) => {
    if (item.objectPath === "/objects/delete-error") throw new Error("Provider unavailable");
    await remove(item);
  };
  const result = await execute(report);
  cleanupServices.remove = remove;
  assert.equal(result.status, "partial");
  for (const name of ["new-reference", "changed-generation", "changed-owner", "delete-error"]) assert.ok(media.has(`/objects/${name}`));
  assert.match(result.objects.find((item) => item.objectPath === "/objects/delete-error")!.outcome, /uncertain/);
  await assert.rejects(() => execute(report), CleanupConflict);
});
test("all completed language variants, fitted voices, captions, posters, recipes and AI assets survive approved cleanup", async () => {
  const p = await project();
  const [job] = await db.insert(autopilotJobsTable).values({ ownerId: owner, projectId: p.id, requestKey: randomUUID(), inputHash: "fixture",
    status: "completed", checkpoint: { source: { objectPath: object("retained-source", "video/mp4").objectPath }, voice: object("checkpoint-voice").objectPath } }).returning();
  await db.insert(aiCheckpointsTable).values({ jobId: job!.id, callKey: "audio", status: "completed", result: { nested: [{ objectPath: object("ai-voice").objectPath }] } });
  const allClips = [];
  for (const language of ["en", "es", "pt"]) {
    const video = object(`${language}-video`, "video/mp4"), voice = object(`${language}-voice`),
      captions = object(`${language}-captions`, "text/plain"), poster = object(`${language}-poster`, "image/jpeg");
    const draft = { title: language, hook: "Hook", script: "Narration", hashtags: "#fixture", pinnedComment: "Comment",
      captions: true, pictureInPicture: false, campaignId: null };
    const [clip] = await db.insert(generatedClipsTable).values({ ...draft, ownerId: owner, projectId: p.id,
      language, creator: "Fixture", mode: "commentary", duration: 2, score: 70, hookScore: 70, visualScore: 70, commentaryScore: 70,
      objectPath: video.objectPath, voiceoverObjectPath: voice.objectPath, captionsObjectPath: captions.objectPath,
      thumbnail: `/api/storage${poster.objectPath}`, videoUrl: `/api/storage${video.objectPath}`,
      renderInfo: { version: 1, snapshot: draft, recipe: { source: { objectPath: "/objects/retained-source" },
        segments: [{ start: 0, end: 2, title: "Source" }], mode: "commentary" } },
    }).returning();
    allClips.push(clip!);
  }
  object("safe-unreferenced-voice");
  const before = new Map(bytes);
  const report = await storageReport(owner, policy, true);
  const result = await execute(report);
  assert.equal(result.objects.find((item) => item.objectPath === "/objects/safe-unreferenced-voice")!.outcome, "deleted");
  for (const clip of allClips) for (const path of [clip.objectPath!, clip.voiceoverObjectPath!, clip.captionsObjectPath!, `/objects/${clip.language}-poster`]) {
    assert.deepEqual(bytes.get(path), before.get(path), `Asset preserved byte-for-byte: ${path}`);
  }
  for (const path of ["/objects/retained-source", "/objects/checkpoint-voice", "/objects/ai-voice"]) assert.ok(bytes.has(path));
  let zip: Buffer | undefined;
  const pack = await buildExport(allClips, owner, {
    ownedFile: (async (path: string) => {
      assert.ok(bytes.has(path), `Export can still read ${path}`);
      return { createReadStream: () => Readable.from([bytes.get(path)!]) };
    }) as unknown as typeof ownedFile,
    storeBytes: async (buffer) => { zip = buffer; return "/objects/new-export"; },
  });
  assert.equal(pack.includesVideo, true);
  for (const clip of allClips) assert.ok(zip!.includes(Buffer.from(`clip-${clip.id}/video.mp4`)));
});
test("queued, paused, failed and retryable jobs freeze orphan intermediates, but expired packs can still be removed", async () => {
  const p = await project();
  const [job] = await db.insert(autopilotJobsTable).values({ ownerId: owner, projectId: p.id, requestKey: randomUUID(),
    inputHash: "fixture", checkpoint: { nested: { input: { objectPath: object("resume-audio").objectPath } } } }).returning();
  object("frozen-orphan");
  for (const status of ["queued", "processing", "retry", "budget_paused", "uncertain", "failed"]) {
    await db.update(autopilotJobsTable).set({ status }).where(eq(autopilotJobsTable.id, job!.id));
    const report = await storageReport(owner, policy);
    assert.equal(report.objects.find((item) => item.objectPath === "/objects/frozen-orphan")?.eligible, false, status);
  }
  object("pack-during-pause", "application/zip");
  const result = await execute(await storageReport(owner, policy, true));
  assert.equal(result.objects.find((item) => item.objectPath === "/objects/pack-during-pause")!.outcome, "deleted");
  assert.ok(bytes.has("/objects/resume-audio"));
  assert.ok(bytes.has("/objects/frozen-orphan"));
  const [processing] = await db.update(autopilotJobsTable).set({ status: "processing", leaseToken: "resume-token" })
    .where(eq(autopilotJobsTable.id, job!.id)).returning();
  const ctx = new JobContext(processing!, "resume-token");
  assert.equal(((ctx.job.checkpoint.nested as { input: { objectPath: string } }).input).objectPath, "/objects/resume-audio");
  await ctx.save("resumed", { objectPath: "/objects/resume-audio" });
  const [resumed] = await db.select().from(autopilotJobsTable).where(eq(autopilotJobsTable.id, job!.id));
  assert.deepEqual(resumed!.checkpoint.resumed, { objectPath: "/objects/resume-audio" });
});
test("reservations protect the exact object without blocking unrelated saves; concurrent confirmations run once", async () => {
  object("concurrent-pack", "application/zip");
  const p = await project();
  const report = await storageReport(owner, policy, true);
  const remove = cleanupServices.remove;
  let checked = false;
  cleanupServices.remove = async (item) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(() => c.query("UPDATE projects SET source_url=$1 WHERE id=$2", [item.objectPath, p.id]), /reserved for cleanup/);
      checked = true;
    } finally { await c.query("ROLLBACK"); c.release(); }
    await pool.query("UPDATE projects SET title='Unrelated save succeeds' WHERE id=$1", [p.id]);
    await remove(item);
  };
  const attempts = await Promise.allSettled([execute(report), execute(report)]);
  cleanupServices.remove = remove;
  assert.ok(checked);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
});
test("HTTP routes enforce sign-in, validate inputs and isolate owner history", async () => {
  assert.equal((await fetch(`${base}/storage/report`, { headers: { "x-auth": "no" } })).status, 401);
  const invalid = await fetch(`${base}/storage/cleanup/preview`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exportDays: 1, intermediateDays: null }) });
  assert.equal(invalid.status, 400);
  const privateHistory = await fetch(`${base}/storage/cleanup/history`, { headers: { "x-owner": "unrelated-owner" } });
  assert.deepEqual(await privateHistory.json(), { items: [], nextCursor: null });
  assert.match(privateHistory.headers.get("Cache-Control")!, /no-store/);
  assert.equal((await fetch(`${base}/storage/report?limit=1000`)).status, 400);
});

test("durable paginated inventory and history stay owner-scoped and reuse warm metadata", async () => {
  media.clear();
  for (let i = 0; i < 130; i++) object(`page-${String(i).padStart(3, "0")}`, "application/zip");
  object("foreign-secret", "application/zip", { owner: "foreign-owner" });
  const first = await storageReport(owner, policy, false, "", 50);
  assert.equal(first.objects.length, 50);
  assert.equal(first.totals.reduce((s, x) => s + x.count, 0), 130);
  const second = await indexedStorageReport(owner, policy, false, first.nextCursor!, 50);
  assert.equal(second.objects.length, 50);
  assert.ok(second.objects.every((x) => x.objectPath > first.nextCursor!));
  const third = await indexedStorageReport(owner, policy, false, second.nextCursor!, 50);
  assert.equal(third.objects.length, 30);
  assert.equal(third.nextCursor, null);
  const page = inventoryServices.page;
  inventoryServices.page = async () => { throw new Error("Warm report must not list"); };
  await indexedStorageReport(owner);
  inventoryServices.page = page;
  const preview = await indexedStorageReport(owner, policy, true);
  assert.equal(preview.objects.length, 25);
  await execute(preview);
  assert.deepEqual((await db.select().from(storageCleanupsTable).where(eq(storageCleanupsTable.id, preview.reportId)))[0]!.report, preview);
  const detail = await cleanupDetail(owner, preview.reportId, "", 10);
  assert.equal(detail?.objects.length, 10);
  assert.ok(detail?.nextCursor);
  assert.equal(await cleanupDetail("foreign-owner", preview.reportId), null);
  const h1 = await cleanupHistory(owner, "", 2);
  assert.equal(h1.items.length, 2);
  const h2 = await cleanupHistory(owner, h1.nextCursor!, 2);
  assert.ok(h2.items.every((x) => !h1.items.some((y) => y.reportId === x.reportId)));
});

test("cross-owner references, nested updates and deletes maintain the live reference index", async () => {
  media.clear();
  const item = object("cross-owner-reference", "application/zip");
  const p = await project("foreign-owner");
  await pool.query("UPDATE projects SET source_url=$1 WHERE id=$2", [item.objectPath, p.id]);
  assert.equal((await storageReport(owner, policy, true)).objects.length, 0);
  await pool.query("UPDATE projects SET source_url='https://example.invalid' WHERE id=$1", [p.id]);
  const preview = await storageReport(owner, policy, true);
  assert.equal(preview.objects.length, 1);
  // A reference committed after preview is protected at reservation time.
  await pool.query("UPDATE projects SET source_url=$1 WHERE id=$2", [item.objectPath, p.id]);
  const result = await execute(preview);
  assert.match(result.objects[0]!.outcome, /skipped/);
  assert.ok(media.has(item.objectPath));
  await pool.query("DELETE FROM projects WHERE id=$1", [p.id]);
  assert.equal((await storageReport(owner, policy, true)).objects.length, 1);
});

test("incremental reconciliation resumes pages and never evicts on a failed listing", async () => {
  media.clear();
  const page = inventoryServices.page;
  const a = object("incremental-a", "application/zip");
  const b = object("incremental-b", "application/zip");
  let calls = 0;
  inventoryServices.page = async (token) => {
    calls++;
    if (!token) return { objects: [a], nextToken: "second-page" };
    assert.equal(token, "second-page");
    if (calls === 2) throw new Error("Provider unavailable");
    return { objects: [b], nextToken: null };
  };
  try {
    const first = await storageReport(owner);
    assert.equal(first.inventoryComplete, false);
    await assert.rejects(() => indexedStorageReport(owner), /Provider unavailable/);
    const state = await pool.query("SELECT page_token FROM storage_inventory_state WHERE scope=$1", [bucketLocation().scope]);
    assert.equal(state.rows[0].page_token, "second-page");
    const complete = await indexedStorageReport(owner);
    assert.equal(complete.inventoryComplete, true);
    assert.deepEqual(complete.objects.map((x) => x.objectPath), [a.objectPath, b.objectPath]);
  } finally { inventoryServices.page = page; }
});

test("metadata indexing requires exact private owner ACLs and valid sizes and creation dates", () => {
  const meta = { size: "1", timeCreated: new Date().toISOString(), metadata: { "custom:aclPolicy": '{"owner":"exact-owner","visibility":"private"}' } };
  assert.equal(inventoryMetadata("/objects/valid", meta)?.owner, "exact-owner");
  for (const acl of ["null", "{}", "{", '{"owner":true,"visibility":"private"}', '{"owner":"exact-owner","visibility":"public"}']) {
    assert.equal(inventoryMetadata("/objects/valid", { ...meta, metadata: { "custom:aclPolicy": acl } }), null);
  }
  assert.equal(inventoryMetadata("/objects/valid", { ...meta, size: "NaN" }), null);
  assert.equal(inventoryMetadata("/objects/valid", { ...meta, timeCreated: "invalid" }), null);
});

test("an uncommitted cross-owner reference wins over cleanup reservation", async () => {
  media.clear();
  const item = object("racing-reference", "application/zip");
  const preview = await storageReport(owner, policy, true);
  const p = await project("foreign-racing-owner");
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE projects SET source_url=$1 WHERE id=$2", [item.objectPath, p.id]);
    const started = performance.now();
    // Keep the writer uncommitted longer than cleanup's 500ms lock acquisition budget.
    const result = await execute(preview);
    assert.ok(performance.now() - started < 2500);
    assert.match(result.objects[0]!.outcome, /skipped/);
    assert.ok(media.has(item.objectPath));
    await writer.query("COMMIT");
  } finally { await writer.query("ROLLBACK"); writer.release(); }
});

test("retryable jobs do not hide eligible exports behind more than 100 protected intermediates", async () => {
  media.clear();
  const own = `retryable:${randomUUID()}`;
  const p = await project(own);
  await db.insert(autopilotJobsTable).values({ ownerId: own, projectId: p.id, requestKey: randomUUID(),
    inputHash: "large-retryable-vault", status: "retry" });
  for (let i = 0; i < 140; i++) object(`aaa-protected-${String(i).padStart(3, "0")}`, "audio/mpeg", { owner: own });
  // Incomplete versions must not consume the first bounded candidate page either.
  for (let i = 0; i < 110; i++) object(`bbb-incomplete-${i}`, "application/zip", { owner: own, generation: "" });
  const pack = object("zzz-eligible-export", "application/zip", { owner: own });
  const preview = await storageReport(own, policy, true);
  assert.deepEqual(preview.objects.map((x) => x.objectPath), [pack.objectPath]);
  assert.equal((await execute(preview, own)).status, "completed");
  assert.equal(media.size, 250, "Every protected intermediate and incomplete export survives");
  assert.equal((await storageReport(own, policy, true)).objects.length, 0);
});

test("benchmark: bounded reports across 120,000 objects, 101 owners and 2,000 audit manifests", async (t) => {
  const { scope } = bucketLocation();
  const sample = object("benchmark-template", "application/zip");
  const c = await pool.connect();
  try {
    await c.query(`INSERT INTO storage_object_index(scope,object_path,owner_id,metadata,seen_run)
      SELECT $1,'/objects/benchmark-'||n,'bench-'||(n%100),
        $2::jsonb || jsonb_build_object('owner','bench-'||(n%100),'objectPath','/objects/benchmark-'||n),'bench'
      FROM generate_series(1,100000) n`, [scope, JSON.stringify(sample)]);
    await c.query(`INSERT INTO storage_object_index(scope,object_path,owner_id,metadata,seen_run)
      SELECT $1,'/objects/large-'||lpad(n::text,6,'0'),'large-owner',
        $2::jsonb || jsonb_build_object('owner','large-owner','objectPath','/objects/large-'||lpad(n::text,6,'0')),'bench'
      FROM generate_series(1,20000) n`, [scope, JSON.stringify(sample)]);
    await c.query(`INSERT INTO storage_object_references SELECT 'benchmark',n::text,
      '/objects/benchmark-'||n,false FROM generate_series(1,100000) n`);
    const template = await indexedStorageReport("large-owner", policy, true);
    await c.query(`INSERT INTO storage_cleanups(id,owner_id,status,report)
      SELECT 'benchmark-history-'||n,CASE WHEN n%2=0 THEN 'large-owner' ELSE 'bench-'||(n%100) END,
        'completed',$1::jsonb FROM generate_series(1,2000) n`, [JSON.stringify(template)]);
    await c.query("ANALYZE storage_object_index");
    await c.query("ANALYZE storage_object_references");
    await c.query("ANALYZE storage_cleanups");
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const r = await indexedStorageReport(i % 2 ? "bench-1" : "large-owner");
      timings.push(performance.now() - start);
      assert.equal(r.objects.length, 50);
      assert.equal(r.totals.reduce((s, x) => s + x.count, 0), i % 2 ? 1000 : 20000);
      assert.ok(Buffer.byteLength(JSON.stringify(r)) < 40000);
    }
    const start = performance.now();
    const history = await cleanupHistory("large-owner");
    const historyMs = performance.now() - start;
    assert.equal(history.items.length, 10);
    assert.ok(history.items.every((r) => r.objects.length === 0));
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 30000);
    assert.ok(Math.max(...timings) < 2000, "Indexed report must stay within a generous two-second regression budget");
    assert.ok(historyMs < 1000);
    t.diagnostic(`Synthetic benchmark: inventory ms=${timings.map((x) => x.toFixed(1)).join(",")}; history ms=${historyMs.toFixed(1)}; max inventory objects=50; history objects=0; preview candidates=${template.objects.length}`);
  } finally { c.release(); }
});
