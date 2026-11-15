# Veloce Engine

A content-production studio for turning authorized VODs into commentary-led vertical clips and preparing reviewed publishing packages.

## Run & Operate

- Managed API workflow: `artifacts/api-server: API Server`
- Managed frontend workflow: `artifacts/veloce-engine: web`
- `pnpm run typecheck` — full workspace type check
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and validation after contract changes
- `pnpm --filter @workspace/db run push` — development database schema
- Python dependencies are declared in `pyproject.toml` and `uv.lock`, installed by the managed Python toolchain into `.pythonlibs`.
- System tools: FFmpeg, ffprobe, yt-dlp. Source transcription uses the managed AI audio integration, without a local speech-model download.

## Product boundaries

- The public initial workspace contains clearly labeled example clips, campaign views and curated source examples. Trending Radar is not a live platform feed.
- Visitors have isolated demo workspaces. Login creates a separate personal workspace; guest example work is not migrated.
- Demo batches simulate progress, never call paid AI, and export metadata only. Live batches require login and an explicit source-rights confirmation.
- Real ingestion accepts completed YouTube/Twitch/Kick VOD URLs or owned uploaded MP4 media. Limits: 500 MB uploads, 2 GB remote downloads, 30 seconds–60 minutes for the full source, 1–4 outputs, one global worker. Remote sources are not truncated. A bounded primary extraction uses YouTube android/web clients and up-to-1080p streams; a second full-source attempt uses default clients and a smaller stream. Provider errors are shown on the batch, with signed URLs and local paths redacted. Live broadcasts, private/DRM media and platform anti-bot restrictions are not bypassed.
- Browser authentication uses express-session/connect-pg-simple with the existing PostgreSQL sessions table, a signed host-only `veloce.sid` cookie, HTTPS/HttpOnly/SameSite=Lax and seven-day expiry. OIDC callback/logout URLs use the incoming trusted-proxy hostname. Older opaque sessions migrate on access without dropping account data; mobile bearer sessions remain supported.
- Authenticated workspaces are real-only: no example seeding, no curated demo sources, and demo projects/clips/campaigns are excluded from lists and summary totals without deleting existing rows. Signed-in project creation overrides stale demo input to false.
- Source uploads show 0–100% byte progress then verification, with 30-second reservation/finalization timeouts, a 60-second transfer inactivity timeout and a 15-minute transfer ceiling. Bytes still go directly to App Storage; failed transfers reset the control and display an error toast.
- The worker uses sampled OpenCV face detection, not continuous face tracking. Chat peak extraction is not implemented; candidates use audio energy and transcript context.
- The pipeline selects energy-ranked 30–45 second windows and synthesizes original MP3 narration through the managed audio integration. Source audio is mixed at 25% during detected narration speech and returns to full volume during silence. Attached campaign audio is mixed at 15% in any mode.
- Animated individual-word captions use timing estimated from the narration speech envelope, not forced word alignment. The opening hook has a dark top banner. Story mode stitches up to four selected moments; Bounty can add a watermark and CTA card.
- Output technical checks verify 1080×1920 and 60fps. Originality/reach values are transparent composition/hook heuristics, not platform approval, copyright clearance or earnings predictions.
- Editor changes save metadata and preview preferences only; saving does not re-render existing MP4s.
- Campaign payouts are projected from entered/example views and CPM, capped at budget. No verified analytics or payment settlement.
- Schedules remain planning drafts; nothing is posted. Settings supports per-owner public client IDs, approval state and OAuth authorization for YouTube/TikTok once the required server secrets and platform approvals are present. Client secrets stay in project Secrets; token responses are encrypted at rest with a key derived from `SESSION_SECRET`. Local disconnect deletes tokens; users may also revoke platform access.
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
- The API process hosts the queue consumer. Real jobs can be interrupted if the process sleeps/restarts; stale heartbeats become explicit failed jobs rather than silently billing for automatic retries.
- For sustained production rendering, move media work to a dedicated always-running worker with cancellation/resource limits. Do not advertise this initial integrated worker as a hardened production service.
- The Studio waits for its first summary request before rendering parallel queries, establishing a consistent isolated demo cookie.
- Use workflow-provided `PORT`/`BASE_PATH`; do not run duplicate servers.
