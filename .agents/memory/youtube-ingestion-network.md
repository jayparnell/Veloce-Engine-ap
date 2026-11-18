---
name: YouTube ingestion network policy
description: User-approved proxy and cookie routing, overriding earlier no-proxy assumptions.
---

The user explicitly requested that this app use its configured PROXY_URL for all yt-dlp operations and HTTP transcript/caption requests, with optional YOUTUBE_COOKIES. Do not remove this support based on older comments or briefs that ruled out proxies.

**Why:** The user changed the product requirements to address YouTube datacenter-IP bot blocks using their residential proxy.

**How to apply:** Preserve consistent configured egress across source metadata, audio and video retrieval and captions. Never log proxy credentials or cookies, and never silently fall back to direct requests when the configured proxy fails. Routing does not guarantee provider acceptance or grant permission to access private or protected content.

The user replaced remote selected-range retrieval with one temporary full-source download per job and local FFmpeg slicing. Pass PROXY_URL unchanged, including DataImpulse usernames. Never append, strip or rewrite session suffixes.

**Why:** The user approved full-VOD transfer instead of remote range retrieval, then explicitly reversed automatic sticky-session rewriting because altered DataImpulse credentials can break proxy authentication.

**How to apply:** Keep source downloads temporary, reuse them for selected clips and bounded audio analysis, and clean them on success, failure, cancellation and Retry. Use native yt-dlp client selection, IPv4 and Node/EJS solving, not a forced iOS/web client. The user requested one fresh subprocess/connection retry on bot checks with `--no-check-certificates --geo-bypass`; scope those flags to that retry, not normal requests or permanent access failures. Do not promise a changed exit IP: rotation is controlled by the proxy provider and raw credentials. Preserve metadata-only feed discovery, source limits and access restrictions; never reintroduce remote `--download-sections`.

Accept universal upstream formats (including WebM/VP9 and HLS), then merge/remux into MP4 rather than requiring an upstream MP4/M4A or H.264 stream.

**Why:** The user reported unavailable formats with the forced iOS/web clients and strict MP4/M4A selection, and explicitly requested native client selection compatible with cookies and Node.js solving.

**How to apply:** Preserve the requested `bv*[height<=1080]+ba/b[height<=1080]/best` fallback. Keep a real-extension output template through temporary-directory routing so single-stream WebM remuxing reaches the expected MP4 path, rather than a double `.mp4.mp4` filename. Use the managed Python package with its solver dependencies; do not silently switch back to an older system binary.
