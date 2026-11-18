---
name: AI billing choice
description: Explicit provider and billing constraint for Veloce Engine media processing
---

The user now requires direct OpenAI requests using `OPENAI_API_KEY`, with no managed billing fallback.

**Why:** The user explicitly superseded earlier managed-only and conditional-BYOK choices while asking to remove the legacy billing wrapper.

**How to apply:** Apply the selected billing route consistently to transcription, scripting and voiceover calls. Do not silently reroute a failing direct-key request to a different billing source. Social-platform OAuth credentials are separate from this AI billing choice.

AI requests use an initial call plus two retries with a fixed three-second delay. No uncertain-usage holds, custom billing checkpoint locks or AI request-unit admission gates.

**Why:** The user explicitly requested this simpler policy after generic billing errors concealed the actual OpenAI failure. Prior approval of ambiguous-timeout billing risk still applies.

**How to apply:** Preserve the final provider HTTP status and message on the job, except credentials. Never replace it with an access or billing explanation. Preserve completed rendering results, job/render quotas, cancellation and leases. This does not relax ambiguous social-posting reconciliation or consent.

Usage reporting must distinguish provider metrics, conservative internal request units, and actual Replit credit charges. Never convert tokens or request units into credits or currency without an official supported charge source.

**Why:** Creators need useful limits even when a provider omits usage or a request has an uncertain outcome; a fabricated credit conversion would imply a spending guarantee the app cannot enforce.

**How to apply:** Reporting is passive and never blocks processing. Retain historical records without reviving their retired billing state machine. Never present logical call counts as actual charges.

Managed JSON-object requests must explicitly contain the literal word “JSON” in a message, even when a prompt shows a JSON-shaped example.

**Why:** The provider rejects JSON-object mode with HTTP400 when that word is absent; a syntactically JSON-looking example alone does not meet its precondition.

**How to apply:** Preserve the explicit output-format instruction when revising AI prompts. Validate usability before treating a generated plan as a reusable successful result.
