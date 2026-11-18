---
name: AI billing choice
description: Explicit provider and billing constraint for Veloce Engine media processing
---

The user's newer pipeline brief overrides the earlier managed-only billing choice: when `OPENAI_API_KEY` is configured, route all OpenAI calls directly to OpenAI and use `gpt-4o-mini` for moment scoring and `whisper-1` for word-timestamp transcription. When no direct key is configured, retain the managed connection rather than requiring an external key.

**Why:** The user now explicitly requested BYOK routing to avoid consuming Replit AI credits when their own key is available. Direct requests are billed by OpenAI and still have provider rate limits.

**How to apply:** Apply the selected billing route consistently to transcription, scripting and voiceover calls. Do not silently reroute a failing direct-key request to a different billing source. Social-platform OAuth credentials are separate from this AI billing choice.

Usage reporting must distinguish provider metrics, conservative internal request units, and actual Replit credit charges. Never convert tokens or request units into credits or currency without an official supported charge source.

**Why:** Creators need useful limits even when a provider omits usage or a request has an uncertain outcome; a fabricated credit conversion would imply a spending guarantee the app cannot enforce.

**How to apply:** Keep unknown usage explicit, retain uncertain attempts when a creator authorizes a repeat, and describe request-unit limits as additional processing controls rather than exact spending caps.

Managed JSON-object requests must explicitly contain the literal word “JSON” in a message, even when a prompt shows a JSON-shaped example.

**Why:** The provider rejects JSON-object mode with HTTP400 when that word is absent; a syntactically JSON-looking example alone does not meet its precondition.

**How to apply:** Preserve the explicit output-format instruction when revising AI prompts. Validate usability before treating a generated plan as a reusable successful result.
