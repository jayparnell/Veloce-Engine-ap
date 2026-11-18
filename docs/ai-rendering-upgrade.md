# AI and rendering pipeline

## Billing and retries

Every production OpenAI request uses `https://api.openai.com/v1` with `OPENAI_API_KEY`. Managed AI routing is no longer used. Missing keys fail explicitly. Scoring and translation use `gpt-4o-mini`; narration uses `gpt-audio`.

The request helper uses standard try/catch: an initial call plus **two retries**, with a fixed **three-second delay**. SDK and batch-library retries are disabled, so retries cannot multiply. Cancellation interrupts waiting. After the final failed call, the original provider HTTP status and message are saved on the job and shown in its red error box. Credentials are redacted, but documentation URLs and diagnostic parameters are preserved.

The AI billing state machine, admission locks, pending billing checkpoints, persistent retry counters and AI request-unit caps are retired. Completed processing results are still cached for resumability. Passive known metrics and historical receipts remain available without gating requests. Retries can still incur additional OpenAI charges, and OpenAI's own rate and quota limits still apply.

Render quotas, active-job and daily-job quotas, cancellation and worker leases remain enforced. The worker never adds its generic media retry on top of exhausted OpenAI retries.

Historical AI approval holds resume automatically on the worker's next poll. Existing queued work may therefore run after the service starts. These rules do **not** relax TikTok review/consent or uncertain social-posting reconciliation.

## Word timing

Source audio and fitted narration use `whisper-1`, `verbose_json`, and `timestamp_granularities: ["word"]`. Narration is tempo-fitted before transcription so captions describe the audio actually used in the rendered MP4. Invalid or absent timestamps are rejected, not replaced with evenly spaced word estimates.

Every Whisper upload is first encoded as mono 64 kbps MP3 (`-ac 1 -b:a 64k`). The final file must be smaller than 24,000,000 bytes, leaving headroom under the 25 MB API limit; oversized recordings fail locally with an instruction to split them and are never uploaded. Source transcription already uses bounded chunks.

Only a successful response with unusable word timestamps may fall back to `faster-whisper` base on CPU (`int8`, two threads). Failed OpenAI requests, including quota and invalid-parameter errors, are never hidden by fallback. CPU transcription is limited to one process across workers. Its model downloads only when requested, into the ignored model cache; tests do not download it.

SRT retains millisecond timestamps. ASS necessarily represents centiseconds and video presentation is bounded by frame rate. ASR recognition/alignment is not perfect speech timing and requires review. Original word-transcribed captions remain reusable during unchanged-narration regeneration; historical estimated captions are upgraded during explicit regeneration. Save itself remains metadata-only and failed replacements leave the prior playable asset set intact.

## Framing and polish

- OpenCV Haar detections are sampled at 2 Hz. Hard cuts reset tracking, with damping inside a scene.
- Single-person scenes use a bounded, smoothly moving 9:16 crop. Persistently separated faces use two 1080×960 panels stacked into 1080×1920. The detector does not identify people or infer the active speaker.
- Existing webcam/content layouts remain evidence-based. No face evidence preserves the full source frame rather than inventing a speaker.
- OpenCV is constrained to a compatible 4.x release: the installed 5.x build lacked the Haar detector and resources.
- ASS captions use groups of 2–4 words, uppercase bold sans-serif, white base text, neon-yellow `&H0000E6FF` emphasis, four-pixel black outline, soft shadow, and active-word scale pop at `(540,1180)`.
- A smooth 1.00→1.07 zoom spans the first 2.5 seconds. Restrained zoom changes occur every seven seconds. Captions are applied after zoom so their safe-zone position stays stable.
- Final audio is normalized after source/narration/campaign mixing with `loudnorm=I=-14:TP=-1.5:LRA=11`. Output remains 1080×1920, 60 fps, with H.264 CRF 20 and 192 kbps AAC.

## Verification

`pipeline-upgrade` runs mocked AI routing and multipart-request checks, PostgreSQL retry/usage/quota/lease tests, HTTP job controls, real local FFmpeg regeneration, and feed regression tests. `media-unit` includes real detector sampling, synthetic two-panel pixel checks, long tracking-expression/zoom evaluation, ASS formatting, caption safeguards and measured loudness.

No paid OpenAI request, live YouTube download, social post or local Whisper model download is made by these tests. Rendering quality on real people and ASR accuracy on real speech still depend on the input and models; tests use explicitly synthetic fixtures, not a claim of parity with another commercial studio.
