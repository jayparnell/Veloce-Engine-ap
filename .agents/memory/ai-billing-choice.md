---
name: AI billing choice
description: Explicit provider and billing constraint for Veloce Engine media processing
---

Use Replit AI Integrations' built-in `gpt-audio` or `gpt-audio-mini` for voiceovers rather than the external `tts-1` speech endpoint. Do not require an external `OPENAI_API_KEY`.

**Why:** The user explicitly wants everything to run on their Replit credits without an external OpenAI key.

**How to apply:** Keep transcription, scripting and voiceover calls on the managed AI connection when maintaining the media pipeline. Social-platform OAuth credentials are separate from this AI billing choice.

Managed JSON-object requests must explicitly contain the literal word “JSON” in a message, even when a prompt shows a JSON-shaped example.

**Why:** The provider rejects JSON-object mode with HTTP400 when that word is absent; a syntactically JSON-looking example alone does not meet its precondition.

**How to apply:** Preserve the explicit output-format instruction when revising AI prompts. Validate usability before treating a generated plan as a reusable successful result.
