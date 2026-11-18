import { db, pool, withQueueDatabase, queueConnection, databaseFailure, QueueDatabaseError, publishQueueTable as queue, socialAccountsTable as accounts, socialConfigsTable, generatedClipsTable as clips, type PublishWork, type Checkpoint } from "@workspace/db";
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
import { pollReadiness } from "../lib/worker-readiness";
import { nextFailure, redactError } from "../lib/failure-policy";
import { isUnifiedProvider, unifiedPublisher } from "./unifiedPublisher";
import { requireUnifiedAuthorization } from "./unified-settings";

export async function runPublishWork(work: PublishWork, transport: typeof fetch = fetch) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, work.accountId));
  const [clip] = await db.select().from(clips).where(and(eq(clips.id, work.clipId), eq(clips.ownerId, work.ownerId)));
  const provider = providerOf(account?.provider);
  if (!account || account.ownerId !== work.ownerId || !clip || !provider || clip.demo || clip.status !== "ready" || !clip.objectPath) throw new ProviderError(400, "Private ready clip or supported account not found.");
  const unified = isUnifiedProvider(account.postingRoute) ? account.postingRoute : null;
  if (!unified && account.postingRoute !== "direct") throw new ProviderError(403, "Posting route configuration is missing.");
  const [config] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, account.ownerId), eq(socialConfigsTable.provider, provider)));
  if (!account.connected || !account.approved || !account.autoEnabled || (!unified && (!config?.appApproved || !config.clientId))) throw new ReviewRequired("Publishing is disabled or application approval is missing. Check account settings before resuming.");
  if (unified) await requireUnifiedAuthorization(work.ownerId, unified);
  const required = PROVIDERS[provider].scopes.split(/[,\s]+/), granted = account.scopes.split(/[,\s]+/);
  if (!unified && !required.every((s) => granted.includes(s))) {
    await db.update(queue).set({ status: "blocked", error: "Required posting scopes are missing. Reauthorize this account." }).where(eq(queue.id, work.id)); return;
  }
  // Application-side account quota is conservative; providers enforce their own limits too.
  const quota = await db.execute(sql`SELECT count(*) AS count FROM autopilot_publish_queue WHERE account_id=${account.id} AND status='published' AND updated_at>now()-interval '24 hours'`);
  if (Number(quota.rows[0]?.count) >= 12) {
    await db.update(queue).set({ retryAt: new Date(Date.now() + 3600000), error: "Daily application limit of 12 confirmed posts per account reached." }).where(eq(queue.id, work.id)); return;
  }
  const token = !unified || (provider === "tiktok" && account.encryptedTokens && !work.checkpoint.unifiedReceipt)
    ? await accountToken(account.id) : { access_token: "" };
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
      if (!live?.connected || !live.approved || !live.autoEnabled || live.postingRoute !== account.postingRoute || (!unified && !liveConfig?.appApproved)) throw new ReviewRequired("Publishing disabled or account disconnected before this action.");
      if (unified) await requireUnifiedAuthorization(work.ownerId, unified);
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
      const [metadata] = await file.getMetadata();
      if (Number(metadata.size) > 250 * 1024 ** 2) throw new ProviderError(400, "Clip exceeds the 250 MB unified publishing bound. Use ZIP export.");
      return signObjectURL({ bucketName: file.bucket.name, objectName: file.name, method: "GET", ttlSec: 3600 });
    },
  };
  const result = unified ? await unifiedPublisher(context, unified, work.id) : await publishAdapter(context);
  if (result.status === "failed") throw new ProviderError(400, result.error ?? "Provider rejected media processing. Review the saved provider identifiers.");
  if (result.status === "published" && !result.remoteId) throw new ReconciliationRequired("Provider did not confirm a remote post ID.");
  await db.update(queue).set({ status: result.status, failureKind: null, remoteId: result.remoteId ?? null, remoteUrl: "remoteUrl" in result ? result.remoteUrl as string ?? null : null, error: result.error ?? null, updatedAt: new Date(), retryAt: result.status === "processing" ? new Date(Date.now() + 60000) : null }).where(eq(queue.id, work.id));
}
export async function publisherTick(shouldStop = () => false, run = runPublishWork, onlyOwner: string | null = null) {
  const session = await queueConnection(pool, "publisher.poll");
  const connection = session.client;
  let acquired = false;
  let failed = false;
  try {
    acquired = Boolean((await connection.query("SELECT pg_try_advisory_lock(74004,0) AS acquired")).rows[0]?.acquired);
    if (!acquired || shouldStop()) return;
    // Allocation contains database work only; timeout aborts its transaction, not a provider request.
    await withQueueDatabase("publisher.allocate", (database) => assignReadyClips(onlyOwner ?? undefined, undefined, database));
    const result = await connection.query(`SELECT q.* FROM autopilot_publish_queue q JOIN social_accounts a ON a.id=q.account_id
      WHERE a.connected=true AND a.approved=true AND a.auto_enabled=true AND q.scheduled_at<=now()
      AND (q.retry_at IS NULL OR q.retry_at<=now()) AND q.status IN ('scheduled','processing','publishing','retry')
       AND ($1::text IS NULL OR q.owner_id=$1)
       ORDER BY q.scheduled_at LIMIT 12`, [onlyOwner]);
    for (const raw of result.rows) {
      if (shouldStop()) break;
      const [work] = await withQueueDatabase("publisher.load_work", async (database) => database.select().from(queue).where(eq(queue.id, Number(raw.id))));
      if (shouldStop()) break;
      if (!work) continue;
      await withQueueDatabase("publisher.mark_work", async (database) => database.update(queue).set({ status: "publishing", updatedAt: new Date() }).where(eq(queue.id, work.id)));
      try { await run(work); }
      catch (error) {
        await recordPublishFailure(work, error);
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (acquired && !failed) await connection.query("SELECT pg_advisory_unlock(74004,0)");
    } catch (error) {
      failed = true;
      throw error;
    } finally { session.release(failed); }
  }
}
export async function recordPublishFailure(work: PublishWork, error: unknown) {
  // Re-read durable effects, including a response saved immediately before a crash.
  const [latest] = await db.select().from(queue).where(eq(queue.id, work.id));
  const ambiguous = Object.entries(latest?.checkpoint ?? {}).some(([key, value]) =>
    key.startsWith("effect:") && (value as { state?: string } | null)?.state === "started");
  const authBlocked = /authorization|Reconnect|configuration is missing/i.test(error instanceof Error ? error.message : "");
  const retry = nextFailure(latest?.attempts ?? work.attempts, new Date(), error instanceof ProviderError ? error.notBefore : null);
  const permanent = error instanceof ProviderError && error.status >= 400 && error.status < 500 && error.status !== 429;
  const status = error instanceof ReviewRequired ? "needs_review"
    : error instanceof ReconciliationRequired || ambiguous ? "reconciliation_required"
    : authBlocked ? "blocked" : permanent ? "failed" : retry.status;
  const failureKind = status === "needs_review" ? "consent_required" : status === "blocked" ? "access_blocked"
    : status === "reconciliation_required" ? "uncertain_publish" : permanent ? "permanent"
    : error instanceof ProviderError && error.status === 429 ? "rate_limited"
    : status === "failed" ? "retry_exhausted" : "transient";
  const safe = redactError(error);
  const attempts = ["needs_review", "reconciliation_required", "blocked"].includes(status) ? latest?.attempts ?? work.attempts : retry.count;
  await db.update(queue).set({ status, attempts, failureKind, error: safe, retryAt: status === "retry" ? retry.retryAt : error instanceof ProviderError ? error.notBefore : null, updatedAt: new Date() }).where(eq(queue.id, work.id));
  logger.warn({ entryId: work.id, status, failureKind, failures: attempts, retryAt: status === "retry" ? retry.retryAt : null, error: safe }, "Publishing paused or rejected");
}
export function startPublisher(readiness = pollReadiness(150000)) {
  let stopping = false;
  const stopHeartbeat = startPollLoop(async () => {
    // Do not let the independent heartbeat hide stalled or failed queue polling.
    if (readiness.snapshot().ready) await serviceHeartbeat("publisher");
  }, 30000, (error) => {
    readiness.observer.failed();
    logger.error({ operation: "publisher.heartbeat", ...databaseFailure(error) }, "Publisher heartbeat failed");
  });
  const stopPolling = startPollLoop(async () => {
    await publisherTick(() => stopping);
    if (!stopping) await serviceHeartbeat("publisher");
  }, 60000, (error) => logger.error({
    operation: error instanceof QueueDatabaseError ? error.operation : "publisher.poll", ...databaseFailure(error),
  }, "Publisher poll failed"), readiness.observer);
  return async () => {
    stopping = true;
    await Promise.all([stopPolling(), stopHeartbeat()]);
  };
}
