---
name: Editor regeneration contract
description: Why saving edits and regenerating media remain separate, with exports tied to a successful render snapshot
---

Keep Save metadata-only and require an explicit regeneration action to spend render allowance or synthesize changed narration. Failed replacements must leave the previous playable asset set intact.

**Why:** The editor previously promised metadata-only saves. Silently making Save trigger paid rendering would change that contract, and exporting newer narration text alongside an older MP4 would misrepresent the actual media.

**How to apply:** Treat rendered copy and its MP4, fitted MP3 and captions as one version. Export that version's copy, with newer saved edits separately identified. Preserve edits made while rendering rather than overwriting them when an older requested version finishes.

Do not infer that a completed job's retained source or AI assets are disposable merely because the job no longer runs.

**Why:** Dubbing and explicit editor regeneration can reuse inputs from a successful original job long after it completed. Removing those inputs would preserve playback while silently breaking later work.

**How to apply:** Retention changes must follow references from completed checkpoints, AI results and render recipes, not just active jobs. Never prune referenced recovery inputs solely by age.
