import { createHash, randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { budgetStatus, outputKey } from "./render-budget";
import { feedIdentity, fetchYoutubeFeed, FeedFetchError, type FeedResult } from "./youtube-feed-client";
import { logger } from "./logger";
import { startPollLoop, type PollObserver } from "./poll-loop";

export type ClaimedFeed = { id: number; owner_id: string; kind: "channel" | "playlist"; provider_id: string; lease_token: string; etag: string | null; last_modified: string | null; baseline_at: Date | null };
type FeedLoader = (identity: ReturnType<typeof feedIdentity>, validators: { etag: string | null; lastModified: string | null }) => Promise<FeedResult>;
async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout='10s'");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}
export async function claimFeed(onlyOwner: string | null = null): Promise<ClaimedFeed | null> {
  const { rows } = await pool.query(`UPDATE youtube_subscriptions SET lease_token=$1,lease_until=now()+interval '2 minutes',next_poll_at=now()+interval '15 minutes'
    WHERE id=(SELECT id FROM youtube_subscriptions WHERE paused=false AND ($2::text IS NULL OR owner_id=$2)
      AND (lease_until IS NULL OR lease_until<now()) AND next_poll_at<=now()
      ORDER BY next_poll_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [randomUUID(), onlyOwner]);
  return rows[0] ?? null;
}
/** A lease token fences stale responses; pause/removal and this commit serialize on the feed row. */
export async function pollFeed(feed: ClaimedFeed, load: FeedLoader = fetchYoutubeFeed) {
  try {
    const result = await load(feedIdentity(feed.kind, feed.provider_id), {
      etag: feed.baseline_at ? feed.etag : null, lastModified: feed.baseline_at ? feed.last_modified : null,
    });
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [feed.owner_id]);
      const { rows: [live] } = await c.query(`SELECT * FROM youtube_subscriptions
        WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND paused=false FOR UPDATE`, [feed.id, feed.lease_token]);
      if (!live) return;
      if (result.unchanged && !live.baseline_at) throw new FeedFetchError("YouTube returned an unchanged response before a baseline. A full feed will be requested again.");
      for (const entry of result.entries) {
        const inserted = await c.query(`INSERT INTO youtube_feed_entries(subscription_id,video_id,baseline) VALUES($1,$2,$3)
          ON CONFLICT DO NOTHING RETURNING video_id`, [feed.id, entry.videoId, !live.baseline_at]);
        if (live.baseline_at && inserted.rowCount) await c.query(`INSERT INTO youtube_sources(owner_id,video_id,title)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [feed.owner_id, entry.videoId, entry.title]);
      }
      await c.query(`UPDATE youtube_subscriptions SET baseline_at=COALESCE(baseline_at,now()),last_checked_at=now(),last_success_at=now(),
        next_poll_at=now()+interval '15 minutes',error=NULL,title=COALESCE($3,title),
        etag=CASE WHEN $4 THEN COALESCE($5,etag) ELSE $5 END,last_modified=CASE WHEN $4 THEN COALESCE($6,last_modified) ELSE $6 END,
        lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
      [feed.id, feed.lease_token, result.title ?? null, result.unchanged, result.etag, result.lastModified]);
    });
  } catch (error) {
    // Fixed messages for unknown exceptions: DB/network errors can carry credentials.
    const message = error instanceof FeedFetchError ? error.message : "Feed check failed. No uploads were marked seen; other feeds continue.";
    await pool.query(`UPDATE youtube_subscriptions SET error=$3,last_checked_at=now(),next_poll_at=now()+interval '15 minutes',
      lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [feed.id, feed.lease_token, message]);
    logger.warn({ feedId: feed.id, error: message }, "YouTube feed check failed");
  }
}
/** Owner job quota and clip reservations commit with admission. Pending rows outlive RSS windows. */
export async function admitFeedSources(owner: string) {
  return transaction(async (c) => {
    // Match the existing manual admission lock, then the shared render-budget lock.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [owner]);
    await c.query("SELECT pg_advisory_xact_lock(74006,hashtext($1))", [owner]);
    // Lock active membership so pause/removal cannot race a later source admission.
    const memberships = await c.query(`SELECT id FROM youtube_subscriptions WHERE owner_id=$1 AND paused=false FOR SHARE`, [owner]);
    const ids = memberships.rows.map((r) => r.id);
    if (!ids.length) return 0;
    const pending = await c.query(`SELECT s.* FROM youtube_sources s WHERE s.owner_id=$1 AND s.state='pending'
      AND (s.retry_at IS NULL OR s.retry_at<=now()) AND EXISTS (SELECT 1 FROM youtube_feed_entries e
        WHERE e.video_id=s.video_id AND e.baseline=false AND e.subscription_id=ANY($2::int[]))
      ORDER BY s.created_at,s.video_id LIMIT 20 FOR UPDATE`, [owner, ids]);
    let admitted = 0;
    for (const entry of pending.rows) {
      const budget = await budgetStatus(c, owner);
      const usage = await c.query(`SELECT
        (SELECT count(*) FROM autopilot_jobs WHERE owner_id=$1 AND status IN ('queued','processing','uncertain','retry','budget_paused'))
        +(SELECT count(*) FROM projects p WHERE p.owner_id=$1 AND p.demo=false AND p.status IN ('queued','processing','uncertain','retry','budget_paused')
          AND NOT EXISTS(SELECT 1 FROM autopilot_jobs j WHERE j.project_id=p.id AND j.original_clip_id IS NULL)) AS active,
        (SELECT count(*) FROM autopilot_admissions WHERE owner_id=$1 AND created_at>now()-interval '24 hours') AS daily`, [owner]);
      const reason = budget.remaining < 5 ? "daily_cap" : Number(usage.rows[0].active) >= 10 || Number(usage.rows[0].daily) >= 20 ? "job_quota" : null;
      if (reason) {
        await c.query("UPDATE youtube_sources SET reason=$3,retry_at=$4 WHERE owner_id=$1 AND video_id=$2", [owner, entry.video_id, reason,
          reason === "daily_cap" ? budget.resetAt : new Date(Date.now() + 60000)]);
        continue;
      }
      const campaign = await c.query("SELECT id FROM monetization_campaigns WHERE owner_id=$1 AND status='active' AND demo=false AND audio_path IS NOT NULL ORDER BY id DESC LIMIT 1", [owner]);
      const { rows: [project] } = await c.query(`INSERT INTO projects(owner_id,source_url,title,mode,clip_count,demo,campaign_id)
        VALUES($1,$2,$3,'commentary',3,false,$4) RETURNING id`, [owner, `https://www.youtube.com/watch?v=${entry.video_id}`, entry.title, campaign.rows[0]?.id ?? null]);
      const requestKey = `rss:${entry.video_id}`, hash = createHash("sha256").update(entry.video_id).digest("hex");
      const { rows: [job] } = await c.query(`INSERT INTO autopilot_jobs(owner_id,project_id,request_key,input_hash,notice)
        VALUES($1,$2,$3,$4,'Auto-Watch RSS upload; source access and media safety checks still apply.') RETURNING id`, [owner, project.id, requestKey, hash]);
      await c.query("INSERT INTO autopilot_admissions(owner_id,project_id,job_id,request_key,input_hash) VALUES($1,$2,$3,$4,$5)", [owner, project.id, job.id, requestKey, hash]);
      for (let i = 0; i < 5; i++) await c.query("INSERT INTO render_reservations(output_key,owner_id,job_id,moment_index) VALUES($1,$2,$3,$4)", [outputKey(job.id, i), owner, job.id, i]);
      await c.query("UPDATE youtube_sources SET state='admitted',project_id=$3,job_id=$4,reason=NULL,retry_at=NULL WHERE owner_id=$1 AND video_id=$2", [owner, entry.video_id, project.id, job.id]);
      admitted++;
    }
    return admitted;
  });
}
export async function feedTick(stopped = () => false, load: FeedLoader = fetchYoutubeFeed) {
  // Bounded work per tick, one network request at a time; leases coordinate all instances.
  for (let i = 0; i < 20 && !stopped(); i++) {
    const feed = await claimFeed();
    if (!feed) break;
    try { await pollFeed(feed, load); }
    catch { logger.error({ feedId: feed.id }, "Feed result could not be persisted; its lease will expire"); }
    if (!stopped()) await pool.query("INSERT INTO autopilot_services(name,heartbeat_at) VALUES('youtube-feeds',now()) ON CONFLICT(name) DO UPDATE SET heartbeat_at=now()");
  }
  if (stopped()) return;
  const owners = await pool.query(`SELECT DISTINCT s.owner_id FROM youtube_sources s WHERE s.state='pending' AND (s.retry_at IS NULL OR s.retry_at<=now())
    AND EXISTS(SELECT 1 FROM youtube_feed_entries e JOIN youtube_subscriptions f ON f.id=e.subscription_id
      WHERE f.owner_id=s.owner_id AND f.paused=false AND e.video_id=s.video_id AND e.baseline=false) LIMIT 50`);
  for (const { owner_id } of owners.rows) {
    if (stopped()) return;
    try { await admitFeedSources(owner_id); } catch { logger.error("YouTube admission failed for a workspace; pending uploads are preserved"); }
  }
  if (!stopped()) await pool.query("INSERT INTO autopilot_services(name,heartbeat_at) VALUES('youtube-feeds',now()) ON CONFLICT(name) DO UPDATE SET heartbeat_at=now()");
}
export function startYoutubeFeeds(observer?: PollObserver) {
  let stopped = false;
  const stop = startPollLoop(() => feedTick(() => stopped), 30000, () => logger.error("YouTube feed polling unavailable"), observer);
  return async () => { stopped = true; await stop(); };
}
