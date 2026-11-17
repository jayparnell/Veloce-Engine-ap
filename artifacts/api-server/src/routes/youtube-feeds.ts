import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { AddYoutubeFeedBody, ListYoutubeFeedsResponse, UpdateYoutubeFeedParams, UpdateYoutubeFeedBody, UpdateYoutubeFeedResponse, AddYoutubeFeedResponse, RemoveYoutubeFeedParams } from "@workspace/api-zod";
import { FeedInputError, FeedFetchError, resolveFeed } from "../lib/youtube-feed-client";

const router: IRouter = Router();
router.use("/autopilot/feeds", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to manage your private YouTube subscriptions." }); return; }
  next();
});
router.get("/autopilot/feeds", async (req, res): Promise<void> => {
  const { rows } = await pool.query(`SELECT f.*,
    (SELECT count(*)::int FROM youtube_feed_entries e JOIN youtube_sources s ON s.owner_id=f.owner_id AND s.video_id=e.video_id
      WHERE e.subscription_id=f.id AND e.baseline=false AND s.state='pending') AS pending_count,
    (SELECT count(*)::int FROM youtube_feed_entries e JOIN youtube_sources s ON s.owner_id=f.owner_id AND s.video_id=e.video_id
      WHERE e.subscription_id=f.id AND e.baseline=false AND s.state='pending' AND s.reason='daily_cap') AS budget_count,
    (SELECT min(s.retry_at) FROM youtube_feed_entries e JOIN youtube_sources s ON s.owner_id=f.owner_id AND s.video_id=e.video_id
      WHERE e.subscription_id=f.id AND e.baseline=false AND s.state='pending' AND s.reason='daily_cap') AS deferred_until
    FROM youtube_subscriptions f WHERE owner_id=$1 ORDER BY id DESC`, [req.workspaceId]);
  const service = await pool.query("SELECT 1 FROM autopilot_services WHERE name='youtube-feeds' AND heartbeat_at>now()-interval '3 minutes'");
  res.json(ListYoutubeFeedsResponse.parse({
    feeds: rows.map((r) => ({ id: r.id, kind: r.kind, providerId: r.provider_id, feedUrl: r.feed_url, title: r.title, paused: r.paused,
      baselineAt: r.baseline_at, lastCheckedAt: r.last_checked_at, lastSuccessAt: r.last_success_at, nextPollAt: r.next_poll_at,
      error: r.error, pendingCount: r.pending_count, budgetDeferredCount: r.budget_count, deferredUntil: r.deferred_until })),
    serviceRunning: !!service.rowCount,
    message: "Checks active feeds every 15 minutes only while the background service runs. First successful check records a baseline, never an old backlog. RSS exposes a bounded recent window and cannot guarantee every upload after long downtime. Polling makes no AI calls. New uploads share your Daily Render Cap (default 15 clips, not sources); insufficient allowance stays pending until midnight EST (fixed UTC-05:00). Existing source and 10-active / 20-daily job safety quotas still apply.",
  }));
});
router.post("/autopilot/feeds", async (req, res): Promise<void> => {
  const input = AddYoutubeFeedBody.safeParse(req.body);
  if (!input.success || input.data.authorizedUse !== true) { res.status(400).json({ error: "Provide a supported YouTube ID/URL and confirm authorized use. Subscribing does not grant rights to reuse or republish." }); return; }
  try {
    const identity = await resolveFeed(input.data.source);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [req.workspaceId]);
      const count = await c.query("SELECT count(*)::int AS n FROM youtube_subscriptions WHERE owner_id=$1", [req.workspaceId]);
      if (count.rows[0].n >= 50) {
        await c.query("ROLLBACK");
        res.status(409).json({ error: "Limit of 50 subscriptions per workspace. Remove a feed before adding another." }); return;
      }
      const added = await c.query(`INSERT INTO youtube_subscriptions(owner_id,kind,provider_id,feed_url,title) VALUES($1,$2,$3,$4,$3)
        ON CONFLICT(owner_id,kind,provider_id) DO NOTHING RETURNING id`, [req.workspaceId, identity.kind, identity.providerId, identity.feedUrl]);
      await c.query("COMMIT");
      if (!added.rowCount) { res.status(409).json({ error: "Already subscribed to this feed. Resume its existing subscription if paused." }); return; }
      res.status(201).json(AddYoutubeFeedResponse.parse({ message: "Subscription added. First successful poll will establish a baseline without processing existing uploads." }));
    } catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  } catch (error) {
    if (!(error instanceof FeedInputError || error instanceof FeedFetchError)) throw error;
    res.status(400).json({ error: error.message });
  }
});
router.patch("/autopilot/feeds/:id", async (req, res): Promise<void> => {
  const params = UpdateYoutubeFeedParams.safeParse(req.params), input = UpdateYoutubeFeedBody.safeParse(req.body);
  if (!params.success || !input.success) { res.status(400).json({ error: "Provide a valid subscription ID and paused setting." }); return; }
  const result = await pool.query(`UPDATE youtube_subscriptions SET paused=$3,lease_token=NULL,lease_until=NULL,
    next_poll_at=CASE WHEN $3 THEN next_poll_at ELSE now() END WHERE id=$1 AND owner_id=$2 RETURNING id`, [params.data.id, req.workspaceId, input.data.paused]);
  if (!result.rowCount) { res.status(404).json({ error: "Subscription not found." }); return; }
  res.json(UpdateYoutubeFeedResponse.parse({ message: input.data.paused ? "Paused future admissions. Already queued jobs and finished clips are preserved." : "Resumed watching. Durable pending uploads remain eligible; the existing baseline is preserved." }));
});
router.delete("/autopilot/feeds/:id", async (req, res): Promise<void> => {
  const params = RemoveYoutubeFeedParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid subscription ID." }); return; }
  const result = await pool.query("DELETE FROM youtube_subscriptions WHERE id=$1 AND owner_id=$2 RETURNING id", [params.data.id, req.workspaceId]);
  if (!result.rowCount) { res.status(404).json({ error: "Subscription not found." }); return; }
  res.sendStatus(204);
});
export default router;
