---
name: Flexible clip selection
description: User-approved moment, source-duration and sparse-speech fallback requirements.
---

Allow 1–3 clips per source, with selected windows lasting 15–55 seconds. Accept completed sources up to four hours (240 minutes).

Keep one or two valid grounded moments rather than rejecting the job for lacking three. If speech/evidence is sparse or no grounded moments survive validation, use audio-energy-ranked or evenly spaced source previews. Do not invent factual or visual claims for those previews.

**Why:** The user wants compilations, challenges and long podcasts/streams to produce clips instead of failing rigid speech-count or one-hour validation.

**How to apply:** Keep selection, slicing, caption timing, Python rendering and regeneration consistent with these limits. Do not conceal real provider errors or disable safe lease-loss cancellation to force a successful job. Other explicit source-size and authorization limits still apply.
