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
- System tools: FFmpeg, ffprobe, yt-dlp. Production AI uses `OPENAI_API_KEY` directly against OpenAI, with no managed fallback or billing holds. Whisper uploads are mono 64kbps MP3, checked below 24MB before sending. See `docs/ai-rendering-upgrade.md`.

## Product boundaries

- No new demo workspaces are seeded. The command center is real-only, with a sign-in gate and displayed authorized-use terms, not a rights checkbox. Trending Radar remains curated, not a live platform feed.
- Guests cannot process media or upload. Existing guest/example rows and existing user media are preserved, not migrated into other owners' accounts.
- The full-width paste input and one Launch button accept up to five sources; only the separated MP4 link opens a picker. Defaults are analytical commentary and vertical output; the newest active campaign with a bed is attached automatically.
- Real ingestion accepts completed YouTube/Twitch/Kick VOD URLs or owned uploaded MP4 media. Limits: 500 MB uploads, 2 GB remote downloads, 30 seconds–60 minutes for the full source, 1–4 outputs, one global worker. Remote sources are not truncated. A bounded primary extraction uses YouTube android/web clients and up-to-1080p streams; a second full-source attempt uses default clients and a smaller stream. Provider errors are shown on the batch, with signed URLs and local paths redacted. Live broadcasts, private/DRM media and platform anti-bot restrictions are not bypassed.
- Browser authentication uses express-session/connect-pg-simple with the existing PostgreSQL sessions table, a signed host-only `veloce.sid` cookie, HTTPS/HttpOnly/SameSite=Lax and seven-day expiry. OIDC callback/logout URLs use the incoming trusted-proxy hostname. Older opaque sessions migrate on access without dropping account data; mobile bearer sessions remain supported.
- Authenticated workspaces are real-only: no example seeding, no curated demo sources, and demo projects/clips/campaigns are excluded from lists and summary totals without deleting existing rows. Signed-in project creation overrides stale demo input to false.
- Source uploads show 0–100% byte progress then verification, with 30-second reservation/finalization timeouts, a 60-second transfer inactivity timeout and a 15-minute transfer ceiling. Bytes still go directly to App Storage; failed transfers reset the control and display an error toast.
- Compatible OpenCV 4 Haar detection at 2Hz drives scene-reset, damped face framing. Separated speakers use stacked 1080×960 panels. Consistent small-corner face evidence permits a webcam/content split; missing evidence preserves the whole frame. Detection is not identity recognition, active-speaker diarization or a gameplay classifier.
- Metadata/timed-caption-first analysis scores 3–5 grounded 30–45 second windows. Missing captions disclose a first-10-minute word-transcription fallback. Retrieval downloads the full MP4 once per job to `/tmp/source_<jobId>.mp4`, prefers H.264 up to 1080p, and slices audio/clips locally. Full sources and merge intermediates are deleted on completion/failure/cancellation; Retry clears interrupted leftovers. DataImpulse proxy usernames use a stable `__ses.<jobId>` suffix across metadata, captions and download operations. Source duration/size limits still apply.
- Original MP3 narration uses the selected AI billing route and is fitted before word transcription. Source audio is mixed at 25% during narration speech and returns to full volume during silence; active campaign audio is 15%. The final mix targets −14 LUFS / −1.5 dBTP. Originals and persisted Spanish/Portuguese variants have distinct playable assets and coherent packs.
- New animated word captions use ASR timestamps from fitted narration, not speech-envelope estimates; recognition still requires review. Uppercase 2–4-word groups use white/yellow emphasis at y=1180, a black outline, shadow and active-word pop. A smooth 2.5-second hook zoom and seven-second zoom changes precede the overlays. Story chapters and Bounty sponsor/CTA assets remain supported. Historical estimates upgrade on explicit regeneration, never Save.
- Output technical checks verify 1080×1920 and 60fps. Originality/reach values are transparent composition/hook heuristics, not platform approval, copyright clearance or earnings predictions.
- Editor Save persists metadata/layout only; **Regenerate saved edits** explicitly queues a real replacement via the media worker. Previous media stays playable until a fenced transaction swaps verified MP4, fitted MP3, SRT and poster together. Exports use the successful render snapshot; newer saved edits are separate. Historical clips without retained source inputs remain playable but require a new source batch to regenerate.
- Vault Storage reports private owner-verified uploads, recovery assets, final clips and export packs. One-time optional retention defaults to keep everything; exact expiring dry runs and typed confirmation are required. Uploads, all MP4s, referenced assets and resumable work stay protected; audit receipts survive media deletion. See `docs/storage-retention.md` for safeguards and verification.
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
- The dedicated worker, not the API process, claims durable leases. Five live source/dub slots, one renderer and one local CPU transcriber are PostgreSQL-lock bounded across processes. Completed AI/assets are reused. AI requests retry twice with a fixed three-second delay; final provider status/messages appear on job cards, with credentials redacted.
- The publisher checks every 60 seconds only while its service is running. Continuous scheduling needs a continuously running host; development sleep or autoscale-to-zero is not scheduling uptime. No production deployment or real posting was performed in verification.
- The command center polls persisted private job/clip progress; authentication changes clear owner-scoped query caches. Existing PostgreSQL secure sessions/trust-proxy configuration remain intact.
- Daily Render Cap defaults to 15 logical clip outputs per owner, including ES/PT variants. Sources reserve up to five outputs before paid work and shrink reservations to the saved plan. Reset is midnight EST, fixed UTC-05:00 year-round; unfinished reservations carry over and completed receipts survive media deletion. This is not an exact AI-credit or monetary cap. Existing 10-active / 20-rolling-daily job quotas remain separate.
- Non-AI media/publishing failures retain one automatic retry at least 60 seconds later (or later Retry-After), then fail terminally. AI billing admissions, checkpoint locks, uncertain states and unit-cap enforcement are removed; passive reporting never gates requests. Exhausted OpenAI calls fail without another worker retry. Ambiguous social-post writes still require reconciliation, and posting consent holds are unchanged.
- Measurements, fixture limitations, provider documentation and test commands are in `docs/autopilot-verification.md`. Targets for acceptance/analysis latency, framing and estimated caption timing are not provider/network guarantees.
- Use workflow-provided `PORT`/`BASE_PATH`; do not run duplicate servers.
