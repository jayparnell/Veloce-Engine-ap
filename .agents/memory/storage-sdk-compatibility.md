---
name: Storage SDK compatibility
description: Why protected storage must be exercised before accepting Google Storage SDK upgrades
---

Preserve the provided Replit sidecar authentication setup and verify private object read, metadata, ACL and write operations when changing Google Storage SDK major versions.

**Why:** Presigned uploads worked, but the newer SDK forced Google Project ID discovery for metadata reads, making protected upload finalization fail in this Replit environment. The compatible 7.x client resolved metadata reads without inventing a GCP project ID or modifying sidecar credentials.

**How to apply:** Do not infer full storage readiness from a successful signed PUT alone, and do not upgrade the storage client major without an end-to-end protected media-storage check.
