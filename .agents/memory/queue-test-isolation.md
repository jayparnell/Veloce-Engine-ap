---
name: Queue test isolation
description: Why queue integration suites sharing a database must run serially despite separate fixture owners or schemas
---

Serialize integration suites that exercise real media-worker or publisher advisory locks, even when each suite uses a separate owner or PostgreSQL schema.

**Why:** Advisory locks are database-wide, not schema-scoped. Parallel suites can steal each other's available worker slots and produce cascading false failures in concurrency and recovery assertions.

**How to apply:** Use the serial Autopilot test command for the complete suite. Preserve real shared lock namespaces in application code; do not change production locks merely to make parallel tests pass.

Serialization must span separately launched validation commands, not only test files within one invocation. Use a shared process lock for validation commands that exercise the worker's database-wide advisory locks.

**Why:** Independently scheduled checks can each be internally serial and still contend with one another, causing skipped fixture work and false failures.

**How to apply:** Keep the same shared lock around all such registered validation commands and any concurrent manual runs.

Queue fixtures also need their own PostgreSQL schema, not just a random owner.

**Why:** A running development media worker can claim synthetic jobs placed in the public queue, changing their checkpoints and outcomes before the test's owner-filtered worker sees them.

**How to apply:** Create fixture queues in an isolated schema and keep all fixture connections on that search path. Keep database-wide lock serialization as a separate requirement.
