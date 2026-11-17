# Auto-Watch YouTube channels and playlists

The Distribution page's **Auto-Watch Channels (RSS)** panel is private to the signed-in owner. It adds future source jobs to the existing Active Swarm, not directly to social accounts. Subscription requires explicit authorized-use confirmation; neither an RSS feed nor a subscription grants permission to reuse or republish another creator's work.

## Inputs and provider references

- Channel IDs: `UC` plus 22 letters, numbers, `_` or `-`.
- Playlist IDs: `PL` IDs of 12–80 characters, or `UU` plus 22 characters. Mixes, private library playlists, video links, arbitrary feeds, HTTP and arbitrary hosts are explicitly unsupported.
- Standard HTTPS `youtube.com`, `www.youtube.com` and `m.youtube.com` URLs: `/channel/UC…`, `/@handle`, `/c/name`, `/user/name`, optionally with `videos`, `shorts`, `streams` or `featured`; `/playlist?list=…` is also supported.
- Personalized channel URLs are resolved using a bounded public channel page's advertised RSS link or channel-ID metadata, with at most three safe redirects. If public metadata is absent or YouTube requires consent/access, paste the UC ID; there is no access-control bypass.
- Feed targets are constructed as `https://www.youtube.com/feeds/videos.xml?channel_id=…` or `?playlist_id=…`. URLs from feed entries are never fetched.

Verified against these sources on 2026-11-17:

- [YouTube channel URL documentation](https://support.google.com/youtube/answer/6180214?hl=en): channel-ID URLs, handles, custom URLs and legacy usernames.
- [YouTube Atom notification documentation](https://developers.google.com/youtube/data/guides/push_notifications): Atom format and `yt:videoId`. Google's notification guide uses the legacy `/xml/feeds/` topic path; the public advertised RSS feeds use `/feeds/`.
- [Feeder's accessible channel and playlist feed documentation](https://feeder.co/knowledge-base/rss-feed-creation/youtube-rss): current public feed paths, channel-page alternate links, playlist IDs and bounded recent window.

## Lifecycle and limits

The existing dedicated Media and Publisher service also runs the watcher. A small maintenance tick checks durable due times; each active feed is eligible every 15 minutes. Requests are sequential, limited to 20 feeds per tick, have a 20-second overall fetch/read timeout, a 512 KiB XML limit (2 MiB for channel metadata), and at most three allowlisted redirects. ETag and Last-Modified are persisted after successful parsing. XML declarations of external entities or doctypes are rejected; entity processing is disabled, nesting is limited and malformed input does not advance seen records.

The first **successful full poll** stores a visible baseline. It does not queue existing entries. Later unseen video IDs are stored durably before admission. Baseline/seen entries are per subscription; source identities are unique per owner across feeds and manual submissions. Existing real projects are indexed by the additive migration. Previously deleted projects whose original URLs no longer exist cannot be reconstructed.

Database leases fence stale poll responses across processes and restarts. Network failures are isolated per feed and retain validators and the baseline. Pending uploads survive disappearing from RSS. RSS only exposes a bounded recent window (commonly about 15 entries): long downtime can lose uploads that never reached this application. This is not historical backfill or a completeness guarantee.

Admission shares the existing owner job quota lock and render-budget lock. Each new source reserves the renderer's worst-case five outputs **atomically with project/job creation**, before it can be claimed for AI work. The default cap is **15 clips, not 15 sources, per fixed EST day**. The renderer reuses those reservations, shrinks unused slots, counts completed output receipts and retains unfinished reservations across midnight. Pending uploads with insufficient allowance wait for the next midnight EST (05:00 UTC year-round), independent of the feed's recent window. A cap below five cannot admit an original source's worst-case plan. Separate 10-active/20-rolling-daily job quotas also defer admission without discarding uploads. Feed polling never invokes AI.

Jobs use the existing default English commentary settings, eligible active campaign, source safety checks, saved checkpoints and retry policy. Private, deleted, live and unsupported media is rejected by the existing pipeline and appears with its failure in Active Swarm; feed transport/XML errors appear on the subscription. Nothing publishes automatically without the existing account settings and platform-specific consent.

Pause/removal serializes with admission and stops **future** admissions from that subscription. It does not cancel jobs already admitted or delete finished clips. Resuming preserves baseline and pending work. Removing a feed leaves durable source identities, so deleting/re-adding subscriptions or media cannot bypass deduplication. Another active feed containing the same pending upload may still admit it.

## Verification

Run without paid calls, media downloads or real publishing:

```sh
pnpm --filter @workspace/scripts exec tsx --test --test-concurrency=1 ../artifacts/api-server/src/tests/youtube-feeds.test.ts
```

The suite uses an isolated PostgreSQL schema and injected response fixtures. Run media-worker suites serially because their PostgreSQL advisory locks are database-wide. The existing `scripts` full Autopilot test command includes this suite.
