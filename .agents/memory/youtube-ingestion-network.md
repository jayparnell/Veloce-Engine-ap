---
name: YouTube ingestion network policy
description: User-approved proxy and cookie routing, overriding earlier no-proxy assumptions.
---

The user explicitly requested that this app use its configured PROXY_URL for all yt-dlp operations and HTTP transcript/caption requests, with optional YOUTUBE_COOKIES. Do not remove this support based on older comments or briefs that ruled out proxies.

**Why:** The user changed the product requirements to address YouTube datacenter-IP bot blocks using their residential proxy.

**How to apply:** Preserve consistent configured egress across source metadata, audio and video retrieval and captions. Never log proxy credentials or cookies, and never silently fall back to direct requests when the configured proxy fails. Routing does not guarantee provider acceptance or grant permission to access private or protected content.
