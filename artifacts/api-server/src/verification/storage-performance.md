# Indexed storage reporting

## Reproduce

Run from the workspace root:

```sh
pnpm --filter @workspace/db run migrate:autopilot
pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/tests/storage-cleanup.test.ts
```

The tests create and drop their own PostgreSQL schema. The benchmark generates
120,000 metadata objects across 101 synthetic owners, 100,000 references, and
2,000 audit manifests. No object bytes, AI calls, publishing, or live-owner
deletions are involved.

Observed development-container results on 2026-11-17:

| Measurement | Result |
| --- | --- |
| Five warm owner inventory requests | 64.5, 17.2, 36.7, 10.2, 26.7 ms |
| Ten audit summaries from 2,000 manifests | 2.0 ms |
| Inventory objects per response | 50 default, 100 maximum |
| Audit summaries per response | 10 default, 20 maximum |
| Audit-detail objects per response | 50 default, 100 maximum |
| Confirmable candidates per dry run | 25 maximum |

Timings include local PostgreSQL requests and object assessment, but not HTTP,
browser rendering, or provider listing latency. They are not production latency
guarantees. The benchmark asserts generous regression budgets of two seconds per
warm inventory request and one second per history page.

## Inventory consistency and work bounds

The inventory key includes the configured bucket/private prefix. Each report
request can advance one listing page of at most 500 objects; simultaneous requests
do not duplicate the same reconciliation work. The durable provider continuation
token resumes after restarts. Completed scans stay warm for one minute. A failed
page is reported as an error, does not advance its token, and cannot evict entries.
Missing entries are evicted only after a complete successful scan.

Reports explicitly identify partial reconciliation and the last complete scan.
Their totals cover all observed objects belonging to that exact ACL owner, not
just the displayed page. This is an observed metadata inventory, not a promise
that external ACL or object changes have already been reconciled. Deletion always
re-reads the provider's current exact-private-owner ACL and object versions.

References are extracted from complete rows, including nested JSON, by transactional
database triggers. Backfill and trigger installation are atomic. All owners'
references participate in protection; the hot path queries only indexed object
paths, never full source tables. Job changes coordinate with cleanup's owner lock
to preserve the running/resumable-job rule.

## Deletion and failure bounds

Each dry run stores at most 25 eligible objects as an immutable manifest. Outcomes
are separate from that manifest. Repeated dry runs move past deleted or reserved
objects; they cannot silently broaden an earlier confirmation.

Each object is reserved in a short database-only transaction. Reference writers
take shared per-path advisory locks; reservation takes the exclusive counterpart,
rechecks references and job state, and atomically records durable deletion intent.
Lock acquisition times out after 500 ms, each statement after 1.5 seconds, and idle
transactions after two seconds. No provider request occurs under those locks.

After reservation, triggers reject new references to that exact path rather than
holding unrelated saves behind storage-provider latency. Metadata and delete
requests use two-second HTTP timeouts with no request retries. Cleanup stops
starting additional objects after a twenty-second processing budget. These
request budgets do not claim to bound provider authentication or network delivery;
the safety guarantee is that provider delays hold no reference locks.

Generation and metageneration preconditions apply to each external delete.
Reservations persist through crashes and uncertain outcomes and are never
automatically replayed or cleared. This can conservatively prevent reuse of an
orphan path; generating/uploading a new asset is safe. Successful and uncertain
reservations both retain evidence. Objects not attempted are kept.

For real sidecar-authenticated reads and conditional deletion, a separate
development-only smoke test is available:

```sh
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/verification/storage-retention.ts --run
```

It only creates/deletes synthetic-owner fixtures. Ages are simulated because
provider creation times are immutable; ACLs, bytes, generations, and deletes are
real.
