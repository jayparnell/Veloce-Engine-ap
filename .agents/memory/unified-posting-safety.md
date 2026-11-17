---
name: Unified posting safety
description: Why canonical provider hosts and explicit ownership binding are required for a shared posting key.
---

Late has rebranded to Zernio. Its canonical API is on zernio.com; existing getlate.dev URLs redirect. Ayrshare's app.ayrshare.com is its dashboard, not its canonical API host.

**Why:** Official documentation inspected during the original integration confirmed the domain migration and unchanged Late keys (https://zernio.com/rebrand). Forwarding Authorization through redirects is unsafe and unnecessary.

**How to apply:** Keep credentials on the explicitly selected, verified canonical API host and refuse redirects. Do not repeat open-ended provider research merely because old brand names appear in a request.

A project-wide posting key must be bound to an explicitly configured workspace owner; never let the first app signup claim its profiles.

**Why:** Authentication identifies an app user, not the owner of shared deployment credentials. First-claim or globally shared discovery could expose another person's social accounts.

**How to apply:** Retain the explicit non-secret owner binding alongside the one server-only API key. Changing the selected service or credential must not reinterpret saved publishing receipts.
