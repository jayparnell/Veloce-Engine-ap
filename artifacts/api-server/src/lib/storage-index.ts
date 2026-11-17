import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { storage } from "./mediaStorage";
import { objectStorageClient } from "./objectStorage";
import type { InventoryObject } from "./storage-retention";

export const INVENTORY_PAGE_SIZE = 500;
export const CLEANUP_BATCH_SIZE = 25;
export const REPORT_PAGE_SIZE = 50;
export function bucketLocation() {
  const scope = storage.getPrivateObjectDir().replace(/\/+$/, "");
  const [, bucket, ...parts] = scope.split("/");
  if (!bucket || !parts.length) throw new Error("Private storage location is invalid");
  return { scope, bucket: objectStorageClient.bucket(bucket), prefix: parts.join("/") + "/" };
}

export function inventoryMetadata(objectPath: string, meta: {
  metadata?: Record<string, unknown>; contentType?: string; size?: string | number;
  timeCreated?: string; generation?: string | number; metageneration?: string | number;
}): InventoryObject | null {
  if (!/^\/objects\/[a-zA-Z0-9/_-]+$/.test(objectPath)) return null;
  let acl: { owner?: unknown; visibility?: unknown };
  try { acl = JSON.parse(String(meta.metadata?.["custom:aclPolicy"] ?? "{}")); } catch { return null; }
  if (!acl || typeof acl.owner !== "string" || !acl.owner || acl.visibility !== "private") return null;
  const bytes = Number(meta.size);
  // Invalid metadata is never allowed into totals or deletion manifests.
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(Date.parse(meta.timeCreated ?? ""))) return null;
  return { objectPath, owner: acl.owner, private: true, contentType: meta.contentType ?? "",
    purpose: String(meta.metadata?.["veloce:purpose"] ?? ""), bytes, createdAt: meta.timeCreated!,
    generation: String(meta.generation ?? ""), metageneration: String(meta.metageneration ?? "") };
}

export const inventoryServices = {
  async page(pageToken?: string): Promise<{ objects: InventoryObject[]; nextToken: string | null }> {
    const { bucket, prefix } = bucketLocation();
    const [files, next] = await bucket.getFiles({ prefix, autoPaginate: false,
      maxResults: INVENTORY_PAGE_SIZE, pageToken });
    return { objects: files.map((file) => inventoryMetadata(`/objects/${file.name.slice(prefix.length)}`, file.metadata))
      .filter((item): item is InventoryObject => item !== null), nextToken: next?.pageToken ?? null };
  },
};

/** One durable listing page per advance. Failed pages never advance or evict cached entries. */
export async function reconcileInventory() {
  const { scope } = bucketLocation();
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query("SELECT pg_try_advisory_lock(hashtextextended($1,74020)) AS locked", [scope])).rows[0].locked;
    if (!locked) return;
    await c.query(`INSERT INTO storage_inventory_state(scope,run_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [scope, randomUUID()]);
    const state = (await c.query("SELECT * FROM storage_inventory_state WHERE scope=$1", [scope])).rows[0];
    // Warm reports do no provider IO for one minute; an unfinished scan always makes progress.
    if (!state.page_token && state.completed_at && Date.now() - new Date(state.advanced_at).getTime() < 60000) return;
    const page = await inventoryServices.page(state.page_token ?? undefined);
    if (page.objects.length > INVENTORY_PAGE_SIZE || page.nextToken === state.page_token && page.nextToken !== null) {
      throw new Error("Invalid inventory page");
    }
    await c.query("BEGIN");
    await c.query(`INSERT INTO storage_object_index(scope,object_path,owner_id,metadata,seen_run)
      SELECT $1, x->>'objectPath',x->>'owner',x,$2 FROM jsonb_array_elements($3::jsonb) x
      ON CONFLICT(scope,object_path) DO UPDATE SET owner_id=excluded.owner_id,metadata=excluded.metadata,seen_run=excluded.seen_run`,
    [scope, state.run_id, JSON.stringify(page.objects.filter((x) => x.private && x.owner))]);
    if (!page.nextToken) {
      await c.query("DELETE FROM storage_object_index WHERE scope=$1 AND seen_run<>$2", [scope, state.run_id]);
    }
    await c.query(`UPDATE storage_inventory_state SET page_token=$2, run_id=$3, advanced_at=now(),
      completed_at=CASE WHEN $2::text IS NULL THEN now() ELSE completed_at END WHERE scope=$1`,
    [scope, page.nextToken, page.nextToken ? state.run_id : randomUUID()]);
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error; // Do not present a provider failure as an empty or successful inventory.
  } finally {
    if (locked) await c.query("SELECT pg_advisory_unlock(hashtextextended($1,74020))", [scope]);
    c.release();
  }
}

export async function references(c: PoolClient, owner: string, paths: string[]) {
  const { rows } = await c.query(`SELECT object_path, bool_or(final) AS final
    FROM storage_object_references WHERE object_path=ANY($1::text[]) GROUP BY object_path`, [paths]);
  const busy = (await c.query(`SELECT EXISTS(SELECT 1 FROM autopilot_jobs
    WHERE owner_id=$1 AND status NOT IN ('completed','cancelled')) AS busy`, [owner])).rows[0].busy;
  const fenced = await c.query("SELECT object_path FROM storage_object_fences WHERE object_path=ANY($1::text[])", [paths]);
  return { refs: new Set<string>([...rows, ...fenced.rows].map((r) => r.object_path)),
    finals: new Set<string>(rows.filter((r) => r.final).map((r) => r.object_path)), busy };
}
