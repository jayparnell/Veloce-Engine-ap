---
name: AI billing choice
description: Explicit provider and billing constraint for Veloce Engine media processing
---

Use Replit AI Integrations' built-in `gpt-audio` or `gpt-audio-mini` for voiceovers rather than the external `tts-1` speech endpoint. Do not require an external `OPENAI_API_KEY`.

**Why:** The user explicitly wants everything to run on their Replit credits without an external OpenAI key.

**How to apply:** Keep transcription, scripting and voiceover calls on the managed AI connection when maintaining the media pipeline. Social-platform OAuth credentials are separate from this AI billing choice.
