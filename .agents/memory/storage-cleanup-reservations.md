---
name: Storage cleanup reservations
description: Why reserved storage paths remain fenced after deletion or uncertain provider outcomes
---

Reserve approved orphan paths durably before external deletion, and never automatically clear or replay a reservation, even after a provider error or process restart.

**Why:** Releasing a reference lock after a timed-out delete is unsafe: the provider may still delete the object after a new reference is saved. Durable reservations let unrelated saves proceed without permitting references to an object whose deletion may be in flight.

**How to apply:** Any future recovery or reservation-release feature must verify the exact owner and object versions, account for uncertain in-flight operations, and require new explicit review rather than replaying the old confirmation. Metadata inventory is an observed snapshot; deletion authority always comes from live ACL/version checks and transactional cross-owner reference protection.
