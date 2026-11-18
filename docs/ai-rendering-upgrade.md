# AI and rendering pipeline

## Billing and retries

When `OPENAI_API_KEY` exists, every production OpenAI request uses `https://api.openai.com/v1` and that key. Without it, the existing managed AI connection is retained. Requests never silently switch billing sources on failure. Scoring and translation use `gpt-4o-mini`; narration retains `gpt-audio`.

Each durable AI checkpoint allows an initial attempt plus **three automatic retries**. Backoff is 2, 4 and 8 seconds, or longer when required by `Retry-After`. Eligibility and attempt counts survive worker restarts. The worker releases its source slot during the wait. Successful checkpoints are reused; simultaneous callers for the same checkpoint share a single invocation.

Stable, owner/job/stage-scoped request keys are sent as `Idempotency-Key` and `X-Client-Request-Id`. They prevent duplicate local results and assist provider tracing, but **do not promise provider-side billing deduplication**. The owner explicitly approved automatic ambiguous-timeout retries despite possible additional charges. Direct OpenAI accounts still have rate limits.

Each attempt keeps a usage receipt: definitive API rejections use zero internal units; uncertain requests remain counted; known metrics stay known even if a later persistence step fails. After exhaustion the job fails clearly rather than awaiting billing approval. A deliberate manual Retry resets attempt counters, not successful results or historical receipts. Quotas, active leases, cancellation and provider cooldowns remain enforced.

Historical AI approval holds resume automatically on the worker's next poll. Existing queued work may therefore run after the service starts. These rules do **not** relax TikTok review/consent or uncertain social-posting reconciliation.

## Word timing

Source audio and fitted narration use `whisper-1`, `verbose_json`, and `timestamp_granularities: ["word"]`. Narration is tempo-fitted before transcription so captions describe the audio actually used in the rendered MP4. Invalid or absent timestamps are rejected, not replaced with evenly spaced word estimates.

If the selected endpoint cannot provide the requested transcription format, or transient API retries are exhausted, a separate checkpoint runs `faster-whisper` base on CPU (`int8`, two threads). Authentication errors are not hidden by fallback. CPU transcription is limited to one process across workers, and it cannot route a request to another paid AI service. Its model downloads only when this fallback is requested, into the ignored generated-artifacts model cache; tests do not download it.

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
