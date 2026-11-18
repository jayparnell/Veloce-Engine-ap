---
name: Worker database deadlines
description: Why queue deadlines must be limited to repeatable bookkeeping and paired with server cancellation
---

Use both a server statement deadline and a socket watchdog for repeatable queue bookkeeping. Reset the statement deadline before handing a session-lock connection to active work; never wrap an entire AI or publishing run in a queue deadline.

**Why:** Destroying a client socket alone does not guarantee PostgreSQL immediately interrupts a running statement or releases its transaction locks. Conversely, a timeout left on a lock holder can release ownership while external work is still active.

**How to apply:** Keep deadlines on explicitly database-only operations, destroy failed sessions instead of returning them to the pool, and test both server cancellation and an unresponsive socket. Keep provider mutation checkpoints and conservative reconciliation outside automatic polling retries.

Readiness must await slot acquisition/claim probes, not merely the launch of background promises.

**Why:** Housekeeping and heartbeats can succeed while every background slot is failing to acquire a connection.

**How to apply:** Observe every background rejection and report recovery only after a later successful poll. During shutdown, stop new polls first and drain active work while retaining the health listener and advisory-lock ownership.
