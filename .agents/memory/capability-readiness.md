---
name: Capability readiness
description: Prevent false unavailable flags and slow initial page loads from tool probes
---

Do not launch Python-based command-line tools synchronously to determine readiness during an HTTP request.

**Why:** A cold yt-dlp version query took over five seconds in this environment, exceeding a short probe timeout, reporting a working installation as unavailable, and blocking the initial app page.

**How to apply:** Use executable availability for inexpensive capability flags, and keep actual tool execution in bounded asynchronous media jobs or explicit diagnostics.
