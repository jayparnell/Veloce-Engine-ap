# Daily render cap and bounded retries

- `pnpm --filter @workspace/scripts run test:autopilot` runs the full TypeScript suite serially: PostgreSQL advisory locks are database-wide even across isolated schemas.
- `pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/tests/guardrails.test.ts` exercises real transactions in a temporary schema and drops it afterward. No AI, downloads or social posts are performed.
- Guardrail fixtures cover parallel multi-source and variant reservations, completed/reserved/remaining counts, fixed UTC-05:00 reset boundaries in summer/winter, carry-over outstanding work, partial completion, deletion-resistant receipts, atomic output commits, stale-lease fencing, zero caps, persisted cap edits, owner boundaries, 60-second one-retry limits, provider Retry-After, nonblocking queue progress, checkpoint reuse and uncertain-effect holds.
- Additive migrations backfill existing real outputs without deleting media. The migration runner applies both migrations; rerunning preserves retry counters and output receipts.
- Sources reserve their maximum five-output plan before any paid analysis, then release unused slots after plan validation. This can pause a source when fewer than five slots remain, even if analysis might later select only three. Each ES/PT variant reserves one additional output. Outstanding reservations carry over midnight; successful output receipts count on their actual completion day.
- Default cap: 15 clips per owner per fixed-EST calendar day. `0` pauses new paid work. Cap edits cannot undercut today's completed plus outstanding reserved outputs. The separate 10-active / 20-job rolling daily safety quotas and all IANA posting slots remain unchanged.
- Safely repeatable failures persist one retry at least 60 seconds later; a second failure becomes terminal `failed`. Healthy provider processing polls are not failed attempts. Permanent validation/access failures, consent requirements, uncertain AI billing and ambiguous publishing remain distinct holds rather than blanket retries. Error details are credential-redacted before database persistence, structured logging and API display.
- Signed-in cap controls are available in Command Center and Distribution. Failure cards expose retry eligibility and corrective actions. A clip cap is not an exact monetary or AI-credit cap; failed work and explicit acknowledgment of uncertain calls may still incur usage.

# Paste-and-Launch Autopilot: operation and verification

## Operating contract

- The command center accepts 1–5 authorized YouTube/Twitch/Kick completed VOD links or verified private MP4 objects. Whitespace separates links, including several on one line. Login is required before processing or upload.
- Launch commits source projects/jobs before returning **202**. No source download or AI request happens in that handler. Use the same idempotency key after a lost response; changing the source set with an existing key returns a conflict.
- Defaults are analytical commentary, vertical output and active word captions. If an owner has active non-demo campaigns with an audio bed, the newest campaign is attached automatically. Authorized-use terms are displayed; no checkbox-consent event is manufactured.
- Per-owner limits are 10 active jobs and 20 source/dub jobs per rolling 24 hours, including legacy entry points and reactivated jobs. Minimal admission receipts survive media deletion, so deletion cannot reset daily usage or silently replay a previously paid launch. A dub request creates at most one ES and one PT job per original; an unchanged repeated request reuses those jobs. Originals remain intact.
- Five PostgreSQL session-lock slots bound actual source/dub work globally. A separate session lock permits one renderer globally; encoders/filters have bounded threads. Leases, heartbeats, fenced writes and private asset checkpoints survive API or worker restarts.
- Completed AI results are reused. A lost/ambiguous request is **not** automatically repeated: the job pauses for review and an explicit acknowledgment that another request may incur usage. Definitive provider rejections retain completed work and surface a safe HTTP-status diagnostic. Completed narration/download assets are checkpointed independently.
- Metadata/caption-first processing uses accessible JSON3, VTT or SRT cues. Missing captions disclose an audio-only fallback limited to the first **10 minutes**, transcribed in 120-second chunks with concurrency two. Only covered material is eligible. Chunk boundaries are coarse; no missing transcript is invented.
- Planning validates source bounds and exact normalized transcript evidence. Short proposed windows may gain actual surrounding context to reach 30 seconds, never invented material; unusable candidates are rejected. At least three valid moments are required. Caption-evidenced filler-only spans and gaps can be removed while retaining at least 30 seconds.
- Remote retrieval downloads the full MP4 once per job, preferring H.264 up to 1080p, with a default-extractor retry. Audio and selected video clips are cut locally with FFmpeg; no `--download-sections` requests remain. DataImpulse uses one job-scoped sticky username for metadata, captions and video/audio streams. Separate video/audio formats may require separate continuous transfers before merging. Temporary full sources and partial streams are removed after processing, and Retry clears leftovers from interrupted attempts. Authentication/private/geo/DRM restrictions remain failures. Bounds include 60-minute source duration, 2 GB source size, 250 MB clipped assets, timeouts and 500 MB verified local uploads.
- Outputs are probed for 1080×1920, 60fps and 30–45 second targets. Sampling at 2Hz drives smoothed temporal face placement. Sustained small-corner-face evidence permits a webcam/content split; this is a layout heuristic, not proof that the content is gameplay. Missing face evidence uses bounded whole-frame fit/padding.
- Source audio is 25% during detected commentary speech and returns to full volume outside it. An attached active campaign bed is 15%. The opening hook is burned in, and each active caption word is highlighted. Caption boundaries are **speech-envelope weighted estimates, not forced word alignment**.
- ES/PT variants translate commentary, hook and copy, then synthesize managed native-language narration and render their own MP4/SRT/MP3 assets. Language/original identity is persisted in clip metadata and export packs. Translation, pronunciation and timing still need human review.
- All media and ZIP objects remain private and owner checked. Export packs contain video, fitted commentary MP3, timed SRT, copy and language-aware metadata. Historical user media is not deleted or replaced by migration.

## Services, migrations and prerequisites

### Worker readiness

`/worker-healthz` returns HTTP 200 only after both the media and publisher queue polls have succeeded recently. A database/poll failure immediately returns 503 with a fixed, safe error rather than an exception, job identifier or connection string. The response includes each poll's last start, success and failure timestamps (Unix milliseconds), current polling flag and freshness window.

Media readiness expires after 30 seconds without success; publisher readiness expires after 150 seconds, allowing its unchanged 60-second polling cadence. Startup is not ready until the first successful polls. A stalled poll cannot refresh its own success timestamp, and publisher heartbeats no longer imply readiness when the publishing poll has failed or become stale. Successful subsequent polls restore readiness without restarting the service.

Shutdown reports `state: draining`, `ready: false` and HTTP 503 while retaining listener ownership until in-flight work finishes. `running: true` alone is not readiness. Health responses are not cached; the health endpoint performs no database queries or external API calls. Existing dashboard service heartbeats remain an eventually consistent indication rather than a substitute for this local readiness endpoint.

Non-billable regressions: `pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/tests/worker-readiness.test.ts ../artifacts/api-server/src/tests/lifecycle.test.ts`. These simulate database failures and recovery without shutting down the real database, rendering media, or posting content.

1. Apply the additive migration to the intended database with `pnpm --filter @workspace/db run migrate:autopilot`. It is transaction/advisory-lock protected and safe to repeat. It does not replace the database or rewrite historical media/session rows.
2. Run the managed `artifacts/api-server: API Server` and **`artifacts/api-server: Media and Publisher`** services. The latter owns both recoverable media work and the 60-second publisher, independently of API restarts. It exposes `/worker-healthz`; the schedule UI also checks durable heartbeats instead of assuming a configured service is running.
3. Continuous scheduling needs a continuously running host. Autoscale can stop at idle; a development workspace can sleep. A configured polling timer is not an uptime guarantee. Replit documents Reserved VM as continuously running: <https://docs.replit.com/features/publishing/deployment-types>. Nothing in this task publishes the app or purchases hosting.
4. AI uses Replit AI Integrations/credits only: managed text analysis, managed transcription, and `gpt-audio` narration. No external OpenAI key or `tts-1` is required. App Storage continues using its existing sidecar authentication and compatible Google Storage SDK.
5. For social authorization, enter public client IDs and approval state in Settings, and configure corresponding server Secrets using the workspace Secrets flow: `GOOGLE_CLIENT_SECRET`, `TIKTOK_CLIENT_SECRET`, `INSTAGRAM_CLIENT_SECRET`, `X_CLIENT_SECRET`. Public redirect URLs are shown in Settings and must match the provider configuration. Do not send credentials through chat.

### Authorized distribution

Each connected provider identity is a separate account, with independently encrypted/refreshable credentials, scopes, opt-in, timezone, slots and optional dubbed variants. Encryption derives from the existing session secret. A completed OAuth exchange does not establish copyright clearance or guarantee app review; actual provider errors remain blockers.

Automatic posting is off until an approved account is connected and explicitly enabled. **Only clips completed after enabling are assigned**; historical vault clips are not unexpectedly backfilled. Disabling/disconnecting stops subsequent remote mutations, without removing clips or ready-to-post exports. Existing reserved UTC instants are retained when future preferences change.

Default configurable wall-clock slots in **America/New_York**:

| Platform | Daily presets |
| --- | --- |
| YouTube Shorts | 12:30 PM, 4:30 PM, 8:30 PM |
| TikTok | 11:30 AM, 3:00 PM, 7:00 PM, 10:00 PM |
| Instagram Reels | 10:00 AM, 7:30 PM |
| X | 9:00 AM, 1:00 PM, 5:30 PM, 9:00 PM |

These are presets, not proven peak-performance claims. Allocation uses real UTC instants with IANA timezone conversion, skips nonexistent spring-forward wall times, chooses only the first fall-back occurrence, and reserves unique account/clip and account/instant pairs.

Provider-specific boundaries:

- **YouTube:** upload/readonly scopes, actual channel identity, saved resumable session and confirmed video ID; status queries reconcile interrupted uploads before another write.
- **TikTok:** `video.publish` access, current creator options and duration limit; **per-video** exact-content preview, blank initial privacy selection, interaction restrictions, reviewed own-brand/partner disclosures and music-usage consent are required even after account opt-in. Partner content requires an explicit public privacy choice. Generated-content disclosure is sent. Upload is explicitly bounded to 64 MB. Only a returned actual post ID is “published”; completed processing without one requires reconciliation.
- **Instagram:** Professional-account business publishing permissions, current content quota, temporary signed provider-fetch URL while ACL remains private, container readiness and confirmed media-publish ID.
- **X:** OAuth2 user/media/write/offline scopes, current v2 chunked media upload and actual confirmed post ID. Ambiguous final writes are not repeated blindly.
- Definite quota rejection is delayed with bounded exponential retry. Conservative local account caps supplement, not replace, provider quotas. Uncertain mutations retain identifiers/checkpoints for reconciliation; no simulated or unconfirmed result is marked published. Some ambiguous outcomes require manual provider-dashboard review rather than an unsafe automatic repeat.

## Checks genuinely exercised

Verification used isolated development owners and an original synthetic source. No real social account was connected, real post sent, production deployment made, or existing user media removed.

- Full workspace TypeScript check passed. Additive migration was applied and repeated successfully.
- **28 Node checks:** real PostgreSQL five-slot concurrency, expired-lease recovery with completed AI/asset reuse, cancellation, uncertain-call non-repetition, rejected AI handling, superseded-token fencing, quota preservation after deleting media, collision-free parallel allocation/no historical backfill, exact schedules/DST, selected-range primary/fallback arguments, blocked-source diagnostics, timed caption parsing/cuts/window expansion, and eleven mocked provider outcome/reconciliation/disclosure checks.
  - Database queue tests must run with the media worker stopped, so it cannot consume their fixtures. These tests do not call AI or publish providers.
- **8 Python checks:** monotonic word cues, safe SRT/ASS plus active highlight markup, source duck/restore gain, campaign bed gain, temporal crop math and duration constraints.
- Real managed source narration → private MP4 → bounded managed transcription → grounded plan → **four original renders**, then **Spanish and Portuguese renders** for one original. Six MP4s passed technical probes. Repeated dub submission reused jobs.
- A private three-language ZIP contained actual MP4, fitted MP3, SRT and language/original metadata. Owner range playback returned HTTP206; anonymous ZIP access was denied.
- One focused browser journey verified the exact signed-out command center, textarea focus/no accidental picker, migrated PostgreSQL session, all six ready cards, actual original/ES/PT playback, real ZIP download, deduplicated dub action, safe invalid-link rejection, secondary-link-only MP4 upload/verification, refresh/API-restart persistence, four-provider setup blockers, empty/unpublished queue, 390×844 responsive layout with 16px focused textarea/no horizontal overflow, and sign-out clearing private cache and media access.
- **OIDC limitation:** the browser test issuer was unavailable (discovery HTTP404), so a real OIDC roundtrip was not tested. The approved alternative seeded only an isolated temporary opaque session through the existing session mechanism; it migrated to the signed cookie, persisted across restart, and was removed at sign-out. No test-auth endpoint or authentication bypass was added. The dead issuer override was cleared; the restored real sign-in start returned HTTP302 to `replit.com`. Native Mobile Safari and actual approved social-account setup/posting remain untested.

### Warm acceptance measurements

Final local development measurements, 100 fresh accepts per batch size after 20 warmups; sequential requests; worker stopped; existing local PostgreSQL pool; bearer-session authentication; shared `localhost:80` proxy:

| Sources per batch | Handler p50 / p95 | Local proxy roundtrip p50 / p95 |
| --- | --- | --- |
| 1 | 7.76 / 10.91 ms | 10.16 / 13.60 ms |
| 5 | 8.57 / 11.88 ms | 10.88 / 15.62 ms |

The handler timer excludes authentication middleware; proxy roundtrip includes authentication and JSON. Six isolated owners were used for single-source tests, 30 for five-source tests, honoring quotas. The **<60ms target was met under these conditions**, not guaranteed across WAN, cold starts, production load or different databases.

### Analysis and caption accuracy

- Successful planning on the saved synthetic 45-second fallback transcript took **3,870ms**. This **did not meet <3 seconds**. It measures the planning stage, not a universal end-to-end transcription/metadata/download latency. No live-caption-source latency percentile is claimed.
- The labeled five-word synthetic speech-envelope fixture measured word-start **MAE101ms / p95 293ms**. This is a limited regression fixture, **not human-speech alignment validation** or proof of general accuracy. Review actual narration and SRT before posting.
- Real provider VOD range transfers, provider OAuth approvals/token refresh/posting, genuine human-face tracking quality and native Mobile Safari were not end-to-end exercised. Range/caption/parser/layout math/provider failure paths were exercised with fixtures or mocked transports. Geo/private/DRM/datacenter restrictions remain real blockers; no bypass was attempted.

## Reproduction and evidence

### Non-billable publisher process interruption fixture

Run `pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/tests/publisher-process.test.ts` against the development database. The fixture refuses production mode, creates a unique synthetic owner and future-dated queue entries, and never selects the real due queue. Synthetic authorization expires in 2099 so token refresh is not needed; every child HTTP request is restricted to the X adapter and redirected to a loopback fake provider. Persisted synthetic media checkpoints prevent any App Storage read, render or AI call. Automatic allocation cannot backfill the fixture account because its enablement date is also in the future.

The tests spawn actual child processes using the production `runPublishWork`, poll loop and service lifecycle. They verify:

- SIGTERM during an accepted, held request returns draining health while retaining the health listener; competing binds fail until the request completes and shutdown finishes. A new process reuses the completed effect without a second post, and the original listener port becomes reusable.
- SIGKILL after provider acceptance preserves PostgreSQL's `started` effect. A new child reports reconciliation required and never repeats the ambiguous mutation or invents a confirmed post ID.
- SIGKILL after the provider response but before completing the effect checkpoint has the same no-repeat guarantee.
- SIGKILL after persisting `started` but before sending the request also requires reconciliation. This intentionally favors avoiding duplicates over assuming that no request was sent.

The fake provider counts real loopback POSTs while the parent queries actual persisted checkpoints, so these checks are not just a mocked in-memory effect map. Only rows belonging to the fixture's random owner are removed, including cascading queue rows; no storage objects are created or removed. The development worker can remain running because all fixture queue entries are future-dated. This specifically exercises X final-post effects; it does not claim process-level coverage for every provider, real OAuth, actual remote posting or automatic reconciliation of an uncertain outcome.

- Non-billable checks registered for task completion: `typecheck`, `autopilot-unit` (pure planner/slot/provider fixtures), `media-unit`, `service-lifecycle` and `publisher-process` (isolated PostgreSQL/process interruption fixtures).
- With the media worker stopped: `pnpm --filter @workspace/scripts run test:autopilot` additionally runs isolated-owner PostgreSQL queue checks and removes only its own rows.
- `pnpm --filter @workspace/scripts exec tsx src/benchmark-autopilot.ts 1` (or `5`) performs fresh acceptance fixtures while the worker is stopped, immediately cancels them and removes only its own owners' rows.
- **Paid, explicit fixture only:** from `artifacts/api-server`, run `../../scripts/node_modules/.bin/tsx src/verification/media.ts`. A numeric isolated fixture job argument resumes existing checkpoints. Never run at startup or automatically in validation.
- Local reports, logs and synthetic media are under `generated-artifacts/verification/`, ignored by Git/deployment. The saved ZIP is a verification output, not a public media URL or a replacement for private app exports.
- Post-merge setup uses the non-interactive additive migration rather than an interactive/general schema push, then builds the dedicated entrypoints. The worker development command also builds before starting, so a fresh checkout does not depend on an API build winning a startup race.

### Clean service startup verification (2026-11-16)

- This task workspace began with no application processes or listeners on the configured service ports. The older duplicate/orphan groups reported in the task handoff were not present here; no manual process kill was needed. Only the existing artifact-managed services were used.
- API development and worker development builds now have separate `dist/api` and `dist/worker` bundles, including their logger transport files. A full post-merge/production build preserves those directories while writing the existing production entrypoints. Post-merge setup still only installs, migrates and builds; workflow reconciliation remains responsible for launching services.
- The worker binds its configured health port before starting either media or publisher polling. A bind failure closes resources without starting work. Both entrypoints handle listener errors and SIGTERM/SIGINT. Worker shutdown blocks new claims, awaits the active media poll/jobs, publisher item and heartbeat, then releases the health listener and closes the database pool. Health returns 503 while draining; forced termination still relies on the unchanged durable leases/checkpoints.
- Concurrent initial start, managed stop/start, and one subsequent restart of all four services succeeded. After stop, all four listener inventories were empty and the previous service processes were absent. After restart, exactly one owning process existed per port: web **23805**, API **8080**, media/publisher **8099**, canvas **8081**. No unexpected EADDRINUSE occurred in managed service logs.
- Shared-proxy requests returned HTTP200 for `/`, `/api/healthz`, `/worker-healthz` and `/__mockup/`. Anonymous `/api/storage/objects/fixture` returned the existing safe HTTP404 denial; `/api/autopilot/schedule` returned HTTP401. Preview showed the unchanged signed-out Paste-and-Launch command center and API-online state, without browser errors.
- No jobs or queued legacy projects existed and no publishing account was enabled before starting the worker. No paid job, upload, real post, production change or user-data deletion was performed. Signed-in private playback was not rerun; storage/authentication routes and slot presets were not modified.
- The non-billable `service-lifecycle` validation covers bind-before-start, occupied-port refusal without polling, listener ownership during drain, repeat stop, port reuse, stop during bind, poll non-overlap/draining, and initial poll rejection handling. Existing slot/provider/media validations remain in place.
- Read-only owner/ancestry inventory: `python3 scripts/src/service-owners.py` (Linux `/proc`, no process environment access). If a future listener belongs to a platform process or a different workspace namespace, document the owner and stop through its managed workflow; do not use broad process kills, fallback ports or duplicate service workflows.

## Provider references

Implementation consulted the current official provider documentation on 2026-11-16. Real app review, credentials, quotas and paid access remain external prerequisites:

- YouTube resumable upload protocol: <https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol>
- TikTok Direct Post: <https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post>
- TikTok Content Sharing Guidelines: <https://developers.tiktok.com/docs/en/content-sharing-guidelines>
- TikTok branded content policy: <https://www.tiktok.com/legal/page/global/bc-policy/en>
- Instagram Login / content publishing: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing>
- X v2 media initialization: <https://docs.x.com/x-api/media/initialize-media-upload>
