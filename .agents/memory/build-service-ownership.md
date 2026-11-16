---
name: Build and service ownership
description: Why build isolation and health listener ownership matter during startup and reconciliation
---

Treat post-merge builds as potentially concurrent with still-running services, not as offline maintenance. Keep development build outputs isolated from one another and preserved by the full build.

**Why:** Setup runs before workflow reconciliation stops/restarts existing processes. Removing a live service's output can break lazily loaded logger transports even when its main module is already in memory.

**How to apply:** When changing build cleanup or launch commands, account for both concurrent API/worker startup and full builds while old processes remain alive. Leave service launch ownership with artifact-managed workflows.

Bind the worker's health listener before polling and retain that listener while draining, reporting unhealthy rather than releasing it early.

**Why:** The health port also prevents a replacement worker from starting while the previous process still owns active work. Releasing it before drain ends weakens process ownership, even though database leases and advisory locks remain necessary.

**How to apply:** Test port refusal without polling, stop during startup, active poll draining and port reuse without invoking paid AI or real publishers.
