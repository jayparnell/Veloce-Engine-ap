---
name: Preview session cookie verification
description: Distinguish the app's secure cookie settings from Preview proxy behavior
---

Preview can rewrite a session cookie's `SameSite=Lax` attribute to `SameSite=None` for its iframe, even when the application and PostgreSQL session cookie configuration remain `Lax`.

**Why:** A session persistence check initially failed against the proxied response despite the application correctly setting Lax. Official Preview guidance confirms Replit manages iframe cookie attributes.

**How to apply:** Verify the configured cookie policy and persisted session separately from Preview's response headers. Test persistence across a server restart and validate the actual published login after publishing. Do not weaken application cookie settings to match Preview or include full cookie values in assertion output.
