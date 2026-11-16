# Veloce Engine

A content-production studio for turning authorized VODs into commentary-led vertical clips and preparing reviewed publishing packages.

## Run & Operate

- Managed API workflow: `artifacts/api-server: API Server`
- Managed recoverable media/publisher workflow: `artifacts/api-server: Media and Publisher`
- Managed frontend workflow: `artifacts/veloce-engine: web`
- `pnpm run typecheck` — full workspace type check
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and validation after contract changes
- `pnpm --filter @workspace/db run push` — development database schema
- `pnpm --filter @workspace/db run migrate:autopilot` — repeatable additive Autopilot migration; see `docs/autopilot-verification.md`
- Python dependencies are declared in `pyproject.toml` and `uv.lock`, installed by the managed Python toolchain into `.pythonlibs`.
- System tools: FFmpeg, ffprobe, yt-dlp. Source transcription uses the managed AI audio integration, without a local speech-model download.

## Product boundaries

- No new demo workspaces are seeded. The command center is real-only, with a sign-in gate and displayed authorized-use terms, not a rights checkbox. Trending Radar remains curated, not a live platform feed.
- Guests cannot process media or upload. Existing guest/example rows and existing user media are preserved, not migrated into other owners' accounts.
- The full-width paste input and one Launch button accept up to five sources; only the separated MP4 link opens a picker. Defaults are analytical commentary and vertical output; the newest active campaign with a bed is attached automatically.
- Real ingestion accepts completed YouTube/Twitch/Kick VOD URLs or owned uploaded MP4 media. Limits: 500 MB uploads, 2 GB remote downloads, 30 seconds–60 minutes for the full source, 1–4 outputs, one global worker. Remote sources are not truncated. A bounded primary extraction uses YouTube android/web clients and up-to-1080p streams; a second full-source attempt uses default clients and a smaller stream. Provider errors are shown on the batch, with signed URLs and local paths redacted. Live broadcasts, private/DRM media and platform anti-bot restrictions are not bypassed.
- Browser authentication uses express-session/connect-pg-simple with the existing PostgreSQL sessions table, a signed host-only `veloce.sid` cookie, HTTPS/HttpOnly/SameSite=Lax and seven-day expiry. OIDC callback/logout URLs use the incoming trusted-proxy hostname. Older opaque sessions migrate on access without dropping account data; mobile bearer sessions remain supported.
- Authenticated workspaces are real-only: no example seeding, no curated demo sources, and demo projects/clips/campaigns are excluded from lists and summary totals without deleting existing rows. Signed-in project creation overrides stale demo input to false.
- Source uploads show 0–100% byte progress then verification, with 30-second reservation/finalization timeouts, a 60-second transfer inactivity timeout and a 15-minute transfer ceiling. Bytes still go directly to App Storage; failed transfers reset the control and display an error toast.
- OpenCV sampling at 2Hz drives temporally smoothed face framing. Consistent small-corner face evidence permits a webcam/content split; missing evidence uses bounded whole-frame padding. This is not a continuously evaluated detector or a gameplay classifier.
- Metadata/timed-caption-first analysis scores 3–5 grounded 30–45 second windows. Missing captions disclose a first-10-minute bounded managed-transcription fallback. Selected-range remote retrieval uses `android,ios,web` with a tested fallback, not a promise that a protocol transfers no extra bytes.
- Managed original MP3 narration is fitted after source edits. Source audio is mixed at 25% during detected narration speech and returns to full volume during silence; active attached campaign audio is 15%. Originals and persisted Spanish/Portuguese variants have distinct playable assets and coherent packs.
- Animated individual-word captions use timing estimated from the narration speech envelope, not forced word alignment. The opening hook has a dark top banner. Story mode stitches up to four selected moments; Bounty can add a watermark and CTA card.
- Output technical checks verify 1080×1920 and 60fps. Originality/reach values are transparent composition/hook heuristics, not platform approval, copyright clearance or earnings predictions.
- Editor changes save metadata and preview preferences only; saving does not re-render existing MP4s.
- Campaign payouts are projected from entered/example views and CPM, capped at budget. No verified analytics or payment settlement.
- Legacy schedule drafts remain separate. Autopilot supports separately authorized YouTube, TikTok, Instagram Professional and X accounts with encrypted credentials derived from `SESSION_SECRET`, timezone-aware configurable presets, actual remote IDs and reconciliation-safe publishing. No posting occurs until an approved connected account is explicitly enabled; historical vault media is not backfilled. TikTok additionally requires per-video privacy/music-usage consent. Provider credentials/review/access remain external prerequisites.
- Platform readiness is a manual review checklist, not live YouTube/TikTok eligibility tracking. Check current official platform policies and dashboard eligibility.

## Architecture

- Frontend: `artifacts/veloce-engine`, React/TypeScript/Vite, Tailwind, React Query, Wouter.
- API: `artifacts/api-server`, Express 5, structured Pino logs.
- Contract: `lib/api-spec/openapi.yaml`; generated client in `lib/api-client-react` and validators in `lib/api-zod`.
- Database: PostgreSQL/Drizzle; domain schema in `lib/db/src/schema`.
- Auth: managed OIDC via `lib/replit-auth-web`, protected upload reservations and object ACLs.
- Media pipeline: `artifacts/api-server/src/pipeline`; durable Postgres queue claimed atomically, local Python/FFmpeg work, private App Storage output.
- Source media, synthesized MP3s, timed SRT captions, rendered videos, thumbnails and ZIP bytes live in private App Storage. Uploads are finalized/verified before the UI reports success. ZIPs contain MP4, voiceover.mp3, captions.srt, captions.txt, metadata.json and publishing copy for real clips. Local scratch data is deleted after each job and excluded from Git/deployment.
- `scripts/fixtures/real-media.mjs` explicitly generates a synthetic authorized test fixture using paid managed audio. It never runs at startup. Python mixing/caption regressions: `.pythonlibs/bin/python3 artifacts/api-server/src/pipeline/test_media_worker.py`.
- `node scripts/fixtures/verify-media.mjs` is an explicit paid development-only API smoke test using that fixture and an isolated development account/session. It verifies uploads, one real render, private access, byte ranges and ZIP contents. Remove its temporary test session afterward with `node scripts/fixtures/verify-media.mjs --cleanup-session`. It is not an OIDC login test and never adds a test-auth endpoint.

## Operational constraints

- All domain queries and mutations are scoped to the current workspace owner; uploaded media remains private.
- The dedicated worker, not the API process, claims durable leases. Five live source/dub slots and one renderer are PostgreSQL-lock bounded across processes. Completed AI/assets are reused; uncertain requests pause for explicit billing acknowledgment, never blind repeat.
- The publisher checks every 60 seconds only while its service is running. Continuous scheduling needs a continuously running host; development sleep or autoscale-to-zero is not scheduling uptime. No production deployment or real posting was performed in verification.
- The command center polls persisted private job/clip progress; authentication changes clear owner-scoped query caches. Existing PostgreSQL secure sessions/trust-proxy configuration remain intact.
- Daily Render Cap defaults to 15 logical clip outputs per owner, including ES/PT variants. Sources reserve up to five outputs before paid work and shrink reservations to the saved plan. Reset is midnight EST, fixed UTC-05:00 year-round; unfinished reservations carry over and completed receipts survive media deletion. This is not an exact AI-credit or monetary cap. Existing 10-active / 20-rolling-daily job quotas remain separate.
- Safely repeatable media/publishing failures get one automatic retry at least 60 seconds later (or later Retry-After); a second failure is terminal. Counts and eligibility persist. Healthy provider polling, consent holds and ambiguous effects do not consume failure retries; uncertain AI needs explicit usage acknowledgment and ambiguous post writes require reconciliation.
- Measurements, fixture limitations, provider documentation and test commands are in `docs/autopilot-verification.md`. Targets for acceptance/analysis latency, framing and estimated caption timing are not provider/network guarantees.
- Use workflow-provided `PORT`/`BASE_PATH`; do not run duplicate servers.
