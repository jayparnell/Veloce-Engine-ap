---
name: Queue test isolation
description: Why queue integration suites sharing a database must run serially despite separate fixture owners or schemas
---

Serialize integration suites that exercise real media-worker or publisher advisory locks, even when each suite uses a separate owner or PostgreSQL schema.

**Why:** Advisory locks are database-wide, not schema-scoped. Parallel suites can steal each other's available worker slots and produce cascading false failures in concurrency and recovery assertions.

**How to apply:** Use the serial Autopilot test command for the complete suite. Preserve real shared lock namespaces in application code; do not change production locks merely to make parallel tests pass.
