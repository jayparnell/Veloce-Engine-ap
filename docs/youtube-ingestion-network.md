# YouTube ingestion networking

The ingestion worker reads `PROXY_URL` for each new yt-dlp invocation and caption request. Supported residential proxy URLs use `http://` or `https://`, optionally with URL-encoded credentials. Invalid proxy settings fail without printing the value or making an unproxied retry. This routes requests through the configured connection; it does not guarantee YouTube accepts a proxy IP or account, and it does not remove private-video, geography, DRM, rights or provider restrictions.

## Coverage

- The subprocess boundary adds `--proxy` before the `--` URL separator for **every** `yt-dlp` call: metadata, bounded audio, selected-range video, full-VOD ingestion and extractor fallbacks.
- Timed caption/transcript HTTP downloads use a scoped authenticated proxy dispatcher. A proxy failure never triggers a direct HTTP retry. Existing host allowlists, redirect refusal, timeouts and streamed size bounds remain.
- AI, storage, OAuth, social publishing and unrelated HTTP traffic are not put through this proxy.
- The adapter does not log command arguments or proxy URLs. Shared error sanitization removes full URLs, configured proxy passwords even in truncated stderr, credential assignments and cookie entries before logs or job cards.

## Optional cookies

If `YOUTUBE_COOKIES` is configured, provide the complete contents of a Netscape-format cookie file, at most 1 MB. Before every yt-dlp call, the worker atomically replaces `/tmp/youtube_cookies.txt` using an exclusively created, mode-0600 temporary file, then passes `--cookies /tmp/youtube_cookies.txt`. Existing symlinks are replaced rather than followed. No cookie values are logged or committed.

Without this secret, the cookie argument is absent even if an older temporary file remains. Do not paste cookies or proxy passwords into chat, job inputs or settings forms.

## Manual Retry

Active Swarm's existing Retry action resets `failures` to zero, clears the prior error and application retry timer, removes expired leases/cancellation state and queues the job immediately. The dedicated worker's normal two-second poll claims it when a slot and render allowance are available; the API does not start a second worker. Successful media/AI checkpoints remain intact.

Ownership, active leases, provider-enforced cooldowns, daily limits and acknowledgment of uncertain billable AI calls still apply. These safety holds are not bypassed by retrying. After editing project Secrets, restart the API and Media and Publisher services so their processes receive the new environment; the current change includes that restart. Running requests do not switch credentials midway.

## Verification

`youtube-network.test.ts` covers argument injection on every source path, independent optional settings, private cookie file permissions and symlink safety, scoped proxy caption parsing, invalid-setting refusal and credential redaction. A real local CONNECT fixture verifies proxy authentication without opening any upstream connection. The guardrail HTTP/PostgreSQL test proves manual Retry resets failed attempts, retains saved work, and can be claimed immediately with a fresh automatic retry allowance.

All fixtures use synthetic credentials. Verification never contacts YouTube, uses the actual proxy credentials, downloads a source or triggers paid AI work.
