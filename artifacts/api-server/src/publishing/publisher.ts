import { db, pool, publishQueueTable as queue, socialAccountsTable as accounts, socialConfigsTable, generatedClipsTable as clips, type PublishWork, type Checkpoint } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { ownedFile } from "../lib/mediaStorage";
import { signObjectURL } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { serviceHeartbeat } from "../pipeline/worker";
import { accountToken } from "./tokens";
import { PROVIDERS, providerOf, ProviderError } from "./providers";
import { publishAdapter, ReconciliationRequired, ReviewRequired, type AdapterContext } from "./adapters";
import { assignReadyClips } from "./allocator";
import { startPollLoop } from "../lib/poll-loop";

export async function runPublishWork(work: PublishWork, transport: typeof fetch = fetch) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, work.accountId));
  const [clip] = await db.select().from(clips).where(and(eq(clips.id, work.clipId), eq(clips.ownerId, work.ownerId)));
  const provider = providerOf(account?.provider);
  if (!account || !clip || !provider || clip.demo || !clip.objectPath) throw new Error("Private ready clip or supported account not found.");
  const [config] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, account.ownerId), eq(socialConfigsTable.provider, provider)));
  if (!account.connected || !account.approved || !account.autoEnabled || !config?.appApproved || !config.clientId) return;
  const required = PROVIDERS[provider].scopes.split(/[,\s]+/), granted = account.scopes.split(/[,\s]+/);
  if (!required.every((s) => granted.includes(s))) {
    await db.update(queue).set({ status: "blocked", error: "Required posting scopes are missing. Reauthorize this account." }).where(eq(queue.id, work.id)); return;
  }
  // Application-side account quota is conservative; providers enforce their own limits too.
  const quota = await db.execute(sql`SELECT count(*) AS count FROM autopilot_publish_queue WHERE account_id=${account.id} AND status='published' AND updated_at>now()-interval '24 hours'`);
  if (Number(quota.rows[0]?.count) >= 12) {
    await db.update(queue).set({ retryAt: new Date(Date.now() + 3600000), error: "Daily application limit of 12 confirmed posts per account reached." }).where(eq(queue.id, work.id)); return;
  }
  const token = await accountToken(account.id);
  const context: AdapterContext = {
    account, clip, token: token.access_token, checkpoint: work.checkpoint, request: transport,
    save: async (key: string, value: unknown) => {
      const [saved] = await db.update(queue).set({ checkpoint: sql`${queue.checkpoint} || ${JSON.stringify({ [key]: value })}::jsonb`, updatedAt: new Date() }).where(eq(queue.id, work.id)).returning();
      if (!saved) throw new ReconciliationRequired("Publishing checkpoint disappeared.");
      context.checkpoint = saved.checkpoint;
    },
    effect: async <T>(key: string, call: () => Promise<T>): Promise<T> => {
      // Check current authorization immediately before every remote mutation.
      const [live] = await db.select().from(accounts).where(eq(accounts.id, work.accountId));
      const [liveConfig] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, work.ownerId), eq(socialConfigsTable.provider, provider)));
      if (!live?.connected || !live.autoEnabled || !liveConfig?.appApproved) throw new ReviewRequired("Publishing disabled or account disconnected before this action.");
      const existing = context.checkpoint[`effect:${key}`] as { state: string; result: T } | null | undefined;
      if (existing?.state === "done") return existing.result;
      if (existing?.state === "started") throw new ReconciliationRequired("A previous provider request may have succeeded. Reconcile the saved identifiers; no duplicate request was sent.");
      await context.save(`effect:${key}`, { state: "started" });
      try {
        const result = await call();
        await context.save(`effect:${key}`, { state: "done", result });
        return result;
      } catch (error) {
        // A definite 4xx rejection has no post. Network/5xx/lost DB writes remain ambiguous.
        if (error instanceof ProviderError && error.status >= 400 && error.status < 500) await context.save(`effect:${key}`, null);
        throw error;
      }
    },
    bytes: async () => {
      const file = await ownedFile(clip.objectPath!, work.ownerId);
      const [meta] = await file.getMetadata();
      if (Number(meta.size) > 250 * 1024 ** 2) throw new Error("Clip exceeds the bounded publishing size.");
      const [bytes] = await file.download(); return bytes;
    },
    mediaUrl: async () => {
      // Explicitly auto-enabled account authorizes this short-lived provider fetch; object ACL stays private.
      const file = await ownedFile(clip.objectPath!, work.ownerId);
      return signObjectURL({ bucketName: file.bucket.name, objectName: file.name, method: "GET", ttlSec: 3600 });
    },
  };
  const result = await publishAdapter(context);
  if (result.status === "published" && !result.remoteId) throw new ReconciliationRequired("Provider did not confirm a remote post ID.");
  await db.update(queue).set({ status: result.status, remoteId: result.remoteId ?? null, error: result.error ?? null, updatedAt: new Date(), retryAt: result.status === "processing" ? new Date(Date.now() + 60000) : null }).where(eq(queue.id, work.id));
}
export async function publisherTick(shouldStop = () => false) {
  const connection = await pool.connect();
  let acquired = false;
  try {
    acquired = Boolean((await connection.query("SELECT pg_try_advisory_lock(74004,0) AS acquired")).rows[0]?.acquired);
    if (!acquired || shouldStop()) return;
    await assignReadyClips();
    const result = await connection.query(`SELECT q.* FROM autopilot_publish_queue q JOIN social_accounts a ON a.id=q.account_id
      WHERE a.connected=true AND a.approved=true AND a.auto_enabled=true AND q.scheduled_at<=now()
      AND (q.retry_at IS NULL OR q.retry_at<=now()) AND q.status IN ('scheduled','processing','publishing','retry')
      ORDER BY q.scheduled_at LIMIT 12`);
    for (const raw of result.rows) {
      if (shouldStop()) break;
      const [work] = await db.select().from(queue).where(eq(queue.id, Number(raw.id)));
      if (shouldStop()) break;
      if (!work) continue;
      await db.update(queue).set({ status: "publishing", attempts: work.attempts + 1, updatedAt: new Date() }).where(eq(queue.id, work.id));
      try { await runPublishWork(work); }
      catch (error) {
        const status = error instanceof ReviewRequired ? "needs_review" : error instanceof ReconciliationRequired ? "reconciliation_required" : error instanceof ProviderError && error.status === 429 ? "retry" : error instanceof ProviderError && error.status >= 400 && error.status < 500 ? "failed" : "reconciliation_required";
        const safe = error instanceof ProviderError || error instanceof ReconciliationRequired || error instanceof ReviewRequired ? error.message
          : "Publishing or authorization outcome is uncertain. Review the provider account and saved identifiers before any repeat.";
        await db.update(queue).set({ status, error: safe, retryAt: status === "retry" ? new Date(Date.now() + Math.min(86400000, 60000 * 2 ** Math.min(work.attempts, 10))) : null, updatedAt: new Date() }).where(eq(queue.id, work.id));
        logger.warn({ entryId: work.id, status }, "Publishing paused or rejected");
      }
    }
  } finally {
    if (acquired) await connection.query("SELECT pg_advisory_unlock(74004,0)").catch(() => {});
    connection.release();
  }
}
export function startPublisher() {
  let stopping = false;
  const stopHeartbeat = startPollLoop(() => serviceHeartbeat("publisher"), 30000, () => logger.error("Publisher heartbeat failed"));
  const stopPolling = startPollLoop(() => publisherTick(() => stopping), 60000, () => logger.error("Publisher poll failed"));
  return async () => {
    stopping = true;
    await Promise.all([stopPolling(), stopHeartbeat()]);
  };
}
