import { randomUUID } from "node:crypto";
import { db, pool, storageCleanupsTable, type PoolClient } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { type StorageReport, type StorageRetention, GetStorageReportResponse as ReportSchema } from "@workspace/api-zod";
import { storage } from "./mediaStorage";
import { objectStorageClient } from "./objectStorage";
import { assessObject, collectObjectPaths, type InventoryObject } from "./storage-retention";

const referenceTables = ["projects", "source_videos", "generated_clips", "monetization_campaigns",
  "autopilot_jobs", "autopilot_ai_calls", "autopilot_publish_queue", "media_uploads"];
const notice = "Only owner-verified private objects are counted. Unknown/unowned legacy objects are kept. All MP4s, uploads and referenced assets are protected. Retention is one-time and off by default; no automatic deletion.";

export async function references(connection: PoolClient, owner: string) {
  const refs = new Set<string>();
  const finals = new Set<string>();
  let busy = false;
  // Check references across ALL owners: even a cross-owner legacy reference must prevent deletion.
  for (const table of referenceTables) {
    const { rows } = await connection.query(`SELECT * FROM ${table}`);
    collectObjectPaths(rows, refs);
    if (table === "generated_clips") for (const row of rows) {
      collectObjectPaths([row.object_path, row.video_url, row.thumbnail, row.voiceover_object_path, row.captions_object_path], finals);
    }
    if (table === "autopilot_jobs") busy = rows.some((row) => row.owner_id === owner && !["completed", "cancelled"].includes(row.status));
  }
  return { refs, finals, busy };
}

function bucketLocation() {
  const [, bucket, ...parts] = storage.getPrivateObjectDir().replace(/\/+$/, "").split("/");
  if (!bucket || !parts.length) throw new Error("Private storage location is invalid");
  return { bucket: objectStorageClient.bucket(bucket), prefix: parts.join("/") + "/" };
}

export async function inventory(): Promise<InventoryObject[]> {
  const { bucket, prefix } = bucketLocation();
  const result: InventoryObject[] = [];
  // GCS listing includes metadata. Do not expose or count objects without an exact private-owner ACL.
  const stream = bucket.getFilesStream({ prefix });
  for await (const file of stream) {
    const meta = file.metadata;
    let acl: { owner?: string; visibility?: string } = {};
    try { acl = JSON.parse(String(meta.metadata?.["custom:aclPolicy"] ?? "{}")); } catch { continue; }
    const path = `/objects/${file.name.slice(prefix.length)}`;
    if (!/^\/objects\/[a-zA-Z0-9/_-]+$/.test(path)) continue;
    result.push({ objectPath: path, owner: acl.owner ?? "", private: acl.visibility === "private",
      contentType: meta.contentType ?? "", purpose: String(meta.metadata?.["veloce:purpose"] ?? ""),
      bytes: Number(meta.size), createdAt: meta.timeCreated ?? "", generation: String(meta.generation ?? ""),
      metageneration: String(meta.metageneration ?? "") });
  }
  return result;
}

export const cleanupServices = {
  inventory,
  async current(path: string): Promise<InventoryObject> {
    const file = await storage.getObjectEntityFile(path);
    const [meta] = await file.getMetadata();
    const acl = JSON.parse(String(meta.metadata?.["custom:aclPolicy"] ?? "{}"));
    return { objectPath: path, owner: acl.owner, private: acl.visibility === "private",
      contentType: meta.contentType ?? "", purpose: String(meta.metadata?.["veloce:purpose"] ?? ""),
      bytes: Number(meta.size), createdAt: meta.timeCreated ?? "", generation: String(meta.generation ?? ""),
      metageneration: String(meta.metageneration ?? "") };
  },
  async remove(item: InventoryObject) {
    const { bucket, prefix } = bucketLocation();
    await bucket.file(prefix + item.objectPath.slice("/objects/".length)).delete({
      ifGenerationMatch: item.generation, ifMetagenerationMatch: item.metageneration,
    });
  },
};

export async function storageReport(owner: string, policy: StorageRetention = { exportDays: null, intermediateDays: null }, persist = false) {
  const connection = await pool.connect();
  let state;
  try { state = await references(connection, owner); } finally { connection.release(); }
  const objects = (await cleanupServices.inventory()).map((item) => assessObject(item, owner, state.refs, state.finals, state.busy, policy))
    .filter((item) => item !== null).sort((a, b) => a.objectPath.localeCompare(b.objectPath));
  const report: StorageReport = { reportId: persist ? randomUUID() : "", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), status: persist ? "preview" : "inventory", policy, objects, notice,
    totals: ["uploads", "recovery intermediates", "final clips", "export packs"].map((category) => ({
      category, bytes: objects.filter((item) => item.category === category).reduce((sum, item) => sum + item.bytes, 0),
      count: objects.filter((item) => item.category === category).length,
    })) };
  if (persist) await db.insert(storageCleanupsTable).values({ id: report.reportId, ownerId: owner, report });
  return report;
}

export async function cleanupHistory(owner: string) {
  const rows = await db.select().from(storageCleanupsTable).where(eq(storageCleanupsTable.ownerId, owner))
    .orderBy(desc(storageCleanupsTable.createdAt)).limit(10);
  return rows.map((row) => ({ ...ReportSchema.parse(row.report), status: row.status }));
}

export class CleanupConflict extends Error {}
export async function confirmCleanup(owner: string, id: string, paths: string[], confirmation: string) {
  const [saved] = await db.select().from(storageCleanupsTable).where(and(eq(storageCleanupsTable.id, id), eq(storageCleanupsTable.ownerId, owner)));
  if (!saved || saved.status !== "preview") throw new CleanupConflict("Dry run not found or already used.");
  const report = ReportSchema.parse(saved.report);
  const candidates = report.objects.filter((item) => item.eligible);
  if (Date.parse(report.expiresAt) <= Date.now() || candidates.length === 0 ||
    confirmation !== `DELETE ${candidates.length} OBJECTS` ||
    JSON.stringify([...paths].sort()) !== JSON.stringify(candidates.map((item) => item.objectPath).sort())) {
    throw new CleanupConflict("Confirmation must match the exact unexpired dry run.");
  }
  const [claimed] = await db.update(storageCleanupsTable).set({ status: "started" }).where(and(eq(storageCleanupsTable.id, id),
    eq(storageCleanupsTable.ownerId, owner), eq(storageCleanupsTable.status, "preview"))).returning();
  if (!claimed) throw new CleanupConflict("This dry run has already been used.");
  report.status = "started";
  const save = () => db.update(storageCleanupsTable).set({ status: report.status, report }).where(eq(storageCleanupsTable.id, id));
  let connection: PoolClient | undefined;
  try {
    connection = await pool.connect();
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '3s'");
    // Block all reference mutations until deletion finishes. A new worker checkpoint/launch cannot race a scan.
    await connection.query(`LOCK TABLE ${referenceTables.join(", ")} IN SHARE MODE`);
    const state = await references(connection, owner);
    for (const item of candidates) {
      try {
        const current = await cleanupServices.current(item.objectPath);
        const decision = assessObject(current, owner, state.refs, state.finals, state.busy, report.policy);
        if (!decision?.eligible || current.generation !== item.generation || current.metageneration !== item.metageneration) {
          item.outcome = "skipped: ownership, references or object metadata changed"; await save(); continue;
        }
        item.outcome = "deleting: outcome uncertain if interrupted";
        await save(); // Durable intent BEFORE external deletion; never blindly replay a started report.
        await cleanupServices.remove(current);
        item.outcome = "deleted";
      } catch {
        item.outcome = item.outcome.startsWith("deleting") ? "uncertain: check storage before a new dry run" : "skipped: object unavailable";
      }
      await save();
    }
    report.status = candidates.every((item) => item.outcome === "deleted") ? "completed" : "partial";
  } catch {
    report.status = "partial";
    report.notice = notice + " Cleanup stopped safely; inspect per-object outcomes. Unattempted objects were kept.";
  } finally {
    if (connection) { await connection.query("ROLLBACK").finally(() => connection!.release()); }
  }
  await save();
  return report;
}
