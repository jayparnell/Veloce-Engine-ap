# Private storage visibility and cleanup

The Vault's Storage section reports owner-verified private objects, grouped as uploads, recovery intermediates, final clip assets and export packs. Source slices (including MP4 slices) are recovery intermediates; the current clip's MP4, fitted voice, SRT and poster count as final clip assets. Each object is counted once. Unowned, public, malformed-ACL and other-owner objects are excluded from the owner's report and cannot be cleaned up.

## Owner flow

1. Open **Clip Vault → Storage** and refresh the inventory.
2. Leave both age fields blank to keep everything (the default). Optionally enter 7–3650 days for export packs and/or intermediates.
3. Run a dry run. It lists exact candidate paths, sizes, versions, age and reasons. No objects are removed.
4. Review the full list. Type the displayed `DELETE N OBJECTS` phrase to approve exactly that manifest. Dry runs expire after 15 minutes and are single-use. Changing a cutoff requires a new dry run.
5. Inspect per-object results and audit history. Skips and partial/uncertain outcomes are not reported as successful deletion.

These are **one-time controls**, not a background retention schedule. Nothing is removed without an explicit confirmation. Removing an expired ZIP does not remove its constituent clips; create a new export from the Vault when needed.

## Protection rules

- Keep every original upload and every playable MP4, even orphaned MP4s.
- Keep every path referenced anywhere in saved projects, source videos, clips, render recipes, campaigns, job checkpoints, AI call results, upload reservations and publishing checkpoints. Scan references across all owners to protect legacy cross-owner references without exposing those references.
- Retain completed-job checkpoints too: future dubbing and regeneration may reuse them.
- Keep all recovery intermediates while the owner has any job other than completed/cancelled, including failed and uncertain work that may be resumed manually.
- Only known generated audio/caption/image types explicitly marked as intermediates can become intermediate candidates. Legacy objects without provenance are kept. Old ZIP packs can be identified by their archive content type, but still must be unreferenced.
- Under short-timeout database reference locks, recheck ownership, private ACL, references, job state, age, generation and metadata version. Hold the locks through removal so a launch, save or checkpoint cannot introduce a new reference between the check and deletion.
- Use generation **and** metadata-version preconditions at the storage provider to reject replacement bytes or changed ACLs.
- Store the immutable dry-run manifest, durable deletion intent and each outcome in `storage_cleanups`. No media foreign keys: audit receipts survive clip/project deletion. A started/interrupted report is never replayed automatically. The UI shows the latest ten reports; older receipts remain stored.
- No changes to sidecar credentials, storage client initialization, ACL authorization, session policy or publishing behavior.

## Verification

```bash
pnpm run typecheck
pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/tests/storage-cleanup.test.ts
```

The isolated-schema tests cover default keep-all, owner totals/isolation, references and nested URLs, exact confirmation, expiration, single use/concurrency, live ownership/version/reference changes, deletion failure evidence, database mutation fencing, EN/ES/PT asset byte preservation and ZIP construction, and paused/failed/retryable job continuation.

Optional **development-only** real-provider smoke test:

```bash
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/verification/storage-retention.ts --run
```

This explicitly creates a synthetic owner and small private fixture assets, removes only that owner's approved fixture candidates, verifies real storage list/read/write/ACL/conditional-delete operations, constructs and inspects a three-language ZIP, resumes a checkpoint, and checks authenticated HTTP range playback and anonymous denial. It cleans up its own fixture objects and rows. GCS creation timestamps are immutable, so only fixture ages are simulated at the service boundary; all provider ACL/version checks and physical deletion operations are real. Media is synthetic video/tone, not a fresh paid multilingual rendering; no AI requests or social posts are made. Browser coverage exercises the exact-confirmation UI with an invented missing-object manifest and verifies a safe skipped result and persistent history, without deleting existing media.

The additive schema migration is included in `migrate:autopilot`, which the existing post-merge script runs.
