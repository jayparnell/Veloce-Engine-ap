---
name: YouTube watch admission policy
description: Product constraints and admission decisions for automatic YouTube ingestion
---

Automatic watching is prospective, with no historical backfill or promise to recover uploads missing from the provider's bounded recent RSS window. It must preserve the existing Paste-and-Launch interface, renderer and slot scheduler.

**Why:** The user requested hands-free ingestion as an addition to the current workflow, not a replacement or unrestricted crawler.

**How to apply:** Keep feed ingestion separate from publishing consent and existing media safety checks. New automation must not silently reinterpret a source count as a clip budget or make metadata polling billable.

Keep pending feed discovery separate from render admission. Reserve the renderer's worst-case output count with admission rather than enqueueing unlimited budget-paused source jobs.

**Why:** Merely queueing every upload when the cap is full exhausts the active-job safety quota and prevents manual work; discarding discovery at the cap loses uploads as they fall out of RSS.

**How to apply:** Preserve pending discoveries across cap resets, provider feed windows and service restarts; use the same owner admission and render-budget locks as manual work.
