import { randomUUID } from "node:crypto";
import type { FileMetadata } from "@google-cloud/storage";
import { db, pool, storageCleanupsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { type StorageReport, type StorageRetention, GetStorageReportResponse as ReportSchema } from "@workspace/api-zod";
import { assessObject, type InventoryObject } from "./storage-retention";
import { bucketLocation, inventoryMetadata, reconcileInventory, references, CLEANUP_BATCH_SIZE, REPORT_PAGE_SIZE } from "./storage-index";

const notice = "Indexed private-owner metadata only; totals reflect the last observed inventory. Unknown/unowned legacy objects are kept. All MP4s, uploads and referenced assets are protected. Cleanup is one-time and off by default.";
export class CleanupConflict extends Error {}
export const cleanupServices = {
  async current(path: string): Promise<InventoryObject> {
    const { bucket, prefix } = bucketLocation();
    const file = bucket.file(prefix + path.slice("/objects/".length));
    const [meta] = await file.request({ method: "GET", uri: "", timeout: 2000, maxRetries: 0 });
    const item = inventoryMetadata(path, meta as FileMetadata);
    if (!item) throw new Error("Object ownership or metadata cannot be verified");
    return item;
  },
  async remove(item: InventoryObject) {
    const { bucket, prefix } = bucketLocation();
    // Per-request retry settings do not alter the shared storage client's behavior.
    await bucket.file(prefix + item.objectPath.slice("/objects/".length)).request({
      method: "DELETE", uri: "", timeout: 2000, maxRetries: 0,
      qs: { ifGenerationMatch: item.generation, ifMetagenerationMatch: item.metageneration },
    });
  },
};

export async function storageReport(owner: string, policy: StorageRetention = { exportDays: null, intermediateDays: null },
  persist = false, cursor = "", limit = REPORT_PAGE_SIZE) {
  await reconcileInventory();
  const { scope } = bucketLocation();
  const c = await pool.connect();
  try {
    // Preview manifests are deliberately small and never paginated confirmations.
    const size = persist ? 100 : Math.max(1, Math.min(100, limit));
    const { rows } = await c.query(`SELECT metadata FROM storage_object_index i
      WHERE scope=$1 AND owner_id=$2 AND object_path>$3
      ${persist ? `AND object_path NOT LIKE '/objects/uploads/%'
        AND NOT EXISTS(SELECT 1 FROM storage_object_references r WHERE r.object_path=i.object_path)
        AND NOT EXISTS(SELECT 1 FROM storage_object_fences f WHERE f.object_path=i.object_path)
        AND COALESCE(metadata->>'generation','')<>''
        AND COALESCE(metadata->>'metageneration','')<>''
        AND ((metadata->>'contentType'='application/zip' AND $5::int IS NOT NULL
          AND (metadata->>'createdAt')::timestamptz < now()-make_interval(days=>$5::int))
        OR (metadata->>'purpose'='intermediate'
          AND NOT EXISTS(SELECT 1 FROM autopilot_jobs
            WHERE owner_id=$2 AND status NOT IN ('completed','cancelled'))
          AND metadata->>'contentType' IN ('audio/mpeg','audio/mp3','text/plain','application/x-subrip','image/jpeg','image/png','image/webp')
          AND $6::int IS NOT NULL AND (metadata->>'createdAt')::timestamptz < now()-make_interval(days=>$6::int)))` : ""}
      ORDER BY object_path LIMIT $4`, persist ? [scope, owner, cursor, size + 1, policy.exportDays, policy.intermediateDays]
      : [scope, owner, cursor, size + 1]);
    const page = rows.slice(0, size).map((r) => r.metadata as InventoryObject);
    const state = await references(c, owner, page.map((x) => x.objectPath));
    let eligible = 0;
    const objects = page.map((item) => {
      const decision = assessObject(item, owner, state.refs, state.finals, state.busy, policy)!;
      if (decision.eligible && ++eligible > CLEANUP_BATCH_SIZE) {
        decision.eligible = false; decision.reason = "Cleanup batch limit: kept; review a later dry run";
      }
      return decision;
    });
    const totals = await c.query(`SELECT CASE WHEN object_path LIKE '/objects/uploads/%' THEN 'uploads'
      WHEN EXISTS(SELECT 1 FROM storage_object_references r WHERE r.object_path=i.object_path AND r.final) THEN 'final clips'
      WHEN metadata->>'contentType'='application/zip' THEN 'export packs' ELSE 'recovery intermediates' END AS category,
      sum((metadata->>'bytes')::numeric)::float8 AS bytes, count(*)::int AS count
      FROM storage_object_index i WHERE scope=$1 AND owner_id=$2 GROUP BY 1`, [scope, owner]);
    const inv = (await c.query("SELECT * FROM storage_inventory_state WHERE scope=$1", [scope])).rows[0];
    const report: StorageReport = { reportId: persist ? randomUUID() : "", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), status: persist ? "preview" : "inventory",
      policy, objects, notice: notice + (persist ? ` Each dry run deletes at most ${CLEANUP_BATCH_SIZE} objects. Run again for the next batch.` : ""),
      totals: ["uploads", "recovery intermediates", "final clips", "export packs"].map((category) =>
        totals.rows.find((r) => r.category === category) ?? { category, bytes: 0, count: 0 }),
      nextCursor: rows.length > size ? page.at(-1)!.objectPath : null,
      inventoryComplete: !!inv?.completed_at && !inv.page_token,
      lastReconciledAt: inv?.completed_at?.toISOString() ?? null };
    if (persist) {
      // Only bounded candidate evidence is retained. Repeated dry runs can progress past protected objects.
      report.objects = objects.filter((o) => o.eligible);
      report.nextCursor = null;
      await c.query("INSERT INTO storage_cleanups(id,owner_id,report) VALUES ($1,$2,$3::jsonb)",
        [report.reportId, owner, JSON.stringify(report)]);
    }
    return report;
  } finally { c.release(); }
}

export async function cleanupHistory(owner: string, cursor = "", limit = 10) {
  const size = Math.max(1, Math.min(20, limit));
  // Cursor uses the stable UUID plus a database timestamp, preserving microseconds and timestamp ties.
  const { rows } = await pool.query(`SELECT id,created_at,status,report - 'objects' AS summary FROM storage_cleanups
    WHERE owner_id=$1 AND ($2='' OR (created_at,id)<(
      SELECT created_at,id FROM storage_cleanups WHERE id=$2 AND owner_id=$1))
    ORDER BY created_at DESC,id DESC LIMIT $3`, [owner, cursor, size + 1]);
  return { items: rows.slice(0, size).map((row) => ReportSchema.parse({ ...row.summary, objects: [], status: row.status })),
    nextCursor: rows.length > size ? rows[size - 1].id as string : null };
}

export async function cleanupDetail(owner: string, id: string, cursor = "", limit = REPORT_PAGE_SIZE) {
  const size = Math.max(1, Math.min(100, limit));
  // Slice JSON in PostgreSQL: old, large manifests never leave the database in full.
  const { rows } = await pool.query(`SELECT s.report-'objects' AS summary,s.status,
    COALESCE((SELECT jsonb_agg(x || jsonb_build_object('outcome',COALESCE(s.outcomes->>(x->>'objectPath'),x->>'outcome')))
      FROM (SELECT x FROM jsonb_array_elements(s.report->'objects') x
        WHERE x->>'objectPath'>$3 ORDER BY x->>'objectPath' LIMIT $4) page),'[]') AS objects
    FROM storage_cleanups s WHERE id=$1 AND owner_id=$2`, [id, owner, cursor, size + 1]);
  const row = rows[0];
  if (!row) return null;
  const objects = row.objects as StorageReport["objects"];
  return ReportSchema.parse({ ...row.summary, status: row.status, objects: objects.slice(0, size),
    nextCursor: objects.length > size ? objects[size - 1].objectPath : null });
}

export async function confirmCleanup(owner: string, id: string, paths: string[], confirmation: string) {
  const [saved] = await db.select().from(storageCleanupsTable).where(and(eq(storageCleanupsTable.id, id), eq(storageCleanupsTable.ownerId, owner)));
  if (!saved || saved.status !== "preview") throw new CleanupConflict("Dry run not found or already used.");
  const report = ReportSchema.parse(saved.report);
  const candidates = report.objects.filter((item) => item.eligible);
  if (Date.parse(report.expiresAt) <= Date.now() || candidates.length === 0 || candidates.length > CLEANUP_BATCH_SIZE ||
    confirmation !== `DELETE ${candidates.length} OBJECTS` ||
    JSON.stringify([...paths].sort()) !== JSON.stringify(candidates.map((item) => item.objectPath).sort())) {
    throw new CleanupConflict("Confirmation must match the exact unexpired dry run of at most 25 objects.");
  }
  const [claimed] = await db.update(storageCleanupsTable).set({ status: "started" }).where(and(eq(storageCleanupsTable.id, id),
    eq(storageCleanupsTable.ownerId, owner), eq(storageCleanupsTable.status, "preview"))).returning({ id: storageCleanupsTable.id });
  if (!claimed) throw new CleanupConflict("This dry run has already been used.");
  report.status = "started";
  const outcomes: Record<string, string> = {};
  const save = () => db.update(storageCleanupsTable).set({ status: report.status, outcomes }).where(eq(storageCleanupsTable.id, id));
  const deadline = Date.now() + 20000;
  for (const item of candidates) {
    if (Date.now() >= deadline) break;
    let reserved = false;
    try {
      const current = await cleanupServices.current(item.objectPath);
      if (current.owner !== owner || current.generation !== item.generation || current.metageneration !== item.metageneration) {
        throw new Error("Changed metadata");
      }
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout='500ms'");
        await c.query("SET LOCAL statement_timeout='1500ms'");
        await c.query("SET LOCAL idle_in_transaction_session_timeout='2s'");
        // Reference writers share this per-path lock. No provider IO occurs while it is held.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,74021))", [owner]);
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,74019))", [item.objectPath]);
        const state = await references(c, owner, [item.objectPath]);
        if (!assessObject(current, owner, state.refs, state.finals, state.busy, report.policy)?.eligible) {
          throw new Error("No longer eligible");
        }
        await c.query("INSERT INTO storage_object_fences(object_path,cleanup_id) VALUES ($1,$2)", [item.objectPath, id]);
        // Durable intent and reservation commit together, before contacting storage.
        await c.query(`UPDATE storage_cleanups SET outcomes=outcomes || jsonb_build_object($2::text,$3::text) WHERE id=$1`,
          [id, item.objectPath, "deleting: outcome uncertain if interrupted"]);
        await c.query("COMMIT");
        reserved = true;
      } catch (error) { await c.query("ROLLBACK"); throw error; }
      finally { c.release(); }
      item.outcome = "deleting: outcome uncertain if interrupted";
      await cleanupServices.remove(current);
      item.outcome = "deleted";
      await pool.query("DELETE FROM storage_object_index WHERE scope=$1 AND object_path=$2",
        [bucketLocation().scope, item.objectPath]);
    } catch {
      item.outcome = reserved ? "uncertain: reserved; check storage before recovery" : "skipped: ownership, references or object metadata changed";
    }
    outcomes[item.objectPath] = item.outcome;
    await save();
  }
  report.status = candidates.every((item) => item.outcome === "deleted") ? "completed" : "partial";
  await save();
  return report;
}
