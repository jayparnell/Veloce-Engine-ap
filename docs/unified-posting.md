# Unified social posting

Implemented in the existing server's `artifacts/api-server/src/publishing/unifiedPublisher.ts`, not a second top-level server.

## Setup

1. Select **Unified Posting API (Ayrshare / Late)** in **Autopilot Schedule & Accounts**.
2. Store the selected service's API key as `SOCIAL_POST_API_KEY` in project Secrets.
3. Set the **non-secret** environment variable `SOCIAL_POST_OWNER_ID` to the owner binding displayed in that panel. This prevents other app signups from accessing a project-wide key's connected profiles. There is no first-user-wins ownership claim.
4. Save the provider, discover accounts and connect each chosen destination. Discovery is read-only. Mapping expires after fifteen minutes and never enables automatic posting.
5. Review slots and explicitly enable the account. The existing timezone presets, no-historical-backfill policy and render cap remain unchanged.

Only one posting route exists per native destination. Changing routes requires stopping automation and resolving pending/uncertain posts first. Direct OAuth settings do not disable unrelated unified destinations. Disconnecting stops future dispatch without deleting existing posts.

TikTok does **not** bypass platform review: it still requires direct TikTok authorization to fetch current creator restrictions, followed by the existing per-video preview, explicit privacy selection, Music Usage confirmation and commercial disclosures. Connect direct TikTok authorization before mapping the account, or authorize it while its unified automation is off. If creator restrictions cannot be verified, posting remains blocked and ZIP export is available. No default privacy is inferred.

## Endpoint hosts

No further provider research was performed during implementation. The adapter uses canonical API endpoints already verified during the earlier investigation:

- Ayrshare: `https://api.ayrshare.com/api/post` (not the dashboard on `app.ayrshare.com`).
- Late: `https://zernio.com/api/v1/posts`. Late's official rebrand page, `https://zernio.com/rebrand`, confirms the API domain change and unchanged keys.

Credential-bearing requests never follow redirects. Ayrshare discovery supports the primary profile of the supplied key, without exposing or guessing Business Profile keys. Late discovery is bounded to 100 accounts; larger responses require a profile-scoped key. Accounts without a verifiable native identity are not mapped, because an aggregator ID cannot safely deduplicate a direct OAuth destination.

## Delivery safety

- Missing key: export-only operation, not simulated production success. Mock responses exist only in tests.
- The existing publisher and slot allocator are reused; there is no second provider-owned schedule.
- Each work item targets one account/platform, so a partial outcome cannot repost successful destinations.
- Idempotency is `veloce:<clipId>:<queue-slot-id>`, transmitted in the provider header and Ayrshare body.
- A durable `started` mutation is saved before sending. Lost or ambiguous responses pause for reconciliation instead of automatic re-submission. A saved `done` response is reused even if the process died before saving its separate receipt.
- Accepted provider receipts are only polled. Only a confirmed target-platform post ID produces `published`; a root API receipt, `pending`, or another destination's success does not.
- Native IDs and allowlisted HTTPS live URLs are saved separately. Private media is supplied through a size-bounded, one-hour signed fetch URL; ACLs remain private. Signed URLs and raw provider errors are not persisted in checkpoints.
- Definite safe failures use the shared one-retry policy, at least sixty seconds later and respecting `Retry-After`. Missing authorization, consent, unavailable plans and uncertain writes do not repeatedly submit.

Exactly-once delivery cannot be guaranteed across independent services; the conservative reconciliation hold prevents this application from blindly resending an uncertain mutation.

## Verification

Run:

```sh
pnpm run typecheck
pnpm --filter @workspace/scripts exec tsx --test --test-concurrency=1 ../artifacts/api-server/src/tests/unified-posting.test.ts
```

Tests exercise both request formats with fake transports, discovery and owner isolation through real HTTP routes, PostgreSQL mappings, real dispatcher receipt recovery, polling-to-confirmed IDs/URLs, partial failure, TikTok consent flags, no-key fallback, rate limits and disconnects. Existing adapter, scheduler, queue, guardrail and process-interruption regressions are also exercised.

No live key, plan purchase, AI render or social post is needed for these checks. Actual provider ingestion of signed media, plan eligibility and real account delivery remain unverified until an owner authorizes live verification. The settings UI is typechecked; authenticated browser interactions are not covered by these backend tests.
