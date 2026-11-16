/**
 * Explicit test child only. Uses the real publisher and lifecycle with an isolated
 * future-dated row; every HTTP call is forced to the parent's loopback fake.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, pool, publishQueueTable } from "@workspace/db";
import { runPublishWork } from "../../publishing/publisher";
import { ReconciliationRequired } from "../../publishing/adapters";
import { serviceLifecycle } from "../../lib/service-lifecycle";
import { startPollLoop } from "../../lib/poll-loop";

const [owner, rawId, origin, mode] = process.argv.slice(2);
assert.notEqual(process.env.NODE_ENV, "production", "Development fixture only");
assert.ok(process.send, "This fixture requires an IPC parent");
assert.match(owner ?? "", /^user:publisher-process-test-[a-f0-9-]+$/);
assert.ok(rawId && Number.isSafeInteger(Number(rawId)));
const target = new URL(origin!);
assert.equal(target.hostname, "127.0.0.1");
assert.equal(target.protocol, "http:");
assert.equal(target.origin, origin);
assert.ok(mode === "normal" || mode === "after-response" || mode === "before-request");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const requested = new URL(input instanceof Request ? input.url : String(input));
  // Even accidental future token refresh/storage calls cannot leave the machine.
  assert.equal(requested.origin, "https://api.x.com", "Unexpected fixture transport");
  const local = new URL(`${requested.pathname}${requested.search}`, origin);
  if (mode === "before-request" && requested.pathname === "/2/tweets") {
    process.send!({ type: "before_request" });
    await new Promise(() => {});
  }
  const response = await originalFetch(local, { ...init, redirect: "error" });
  if (mode === "after-response" && requested.pathname === "/2/tweets") {
    // The provider has accepted the mutation, but the caller never receives its
    // result. The parent kills us after the durable `started` checkpoint exists.
    process.send!({ type: "response_received" });
    await new Promise(() => {});
  }
  return response;
}) as typeof fetch;

let stopPolling: (() => Promise<void>) | undefined;
let completed = false;
const health = createServer((_req, res) => {
  res.writeHead(lifecycle.stopping ? 503 : 200, { "Content-Type": "application/json", "Connection": "close" });
  res.end(JSON.stringify({ draining: lifecycle.stopping }));
});
const lifecycle = serviceLifecycle(health, {
  port: 0,
  start() {
    stopPolling = startPollLoop(async () => {
      if (completed) return;
      completed = true;
      const [work] = await db.select().from(publishQueueTable)
        .where(and(eq(publishQueueTable.id, Number(rawId)), eq(publishQueueTable.ownerId, owner!)));
      assert.ok(work, "Fixture work missing");
      assert.ok(work.scheduledAt.getTime() > Date.now(), "Fixture must not enter the real publisher's due queue");
      try {
        await runPublishWork(work);
        process.send!({ type: "completed" });
      } catch (error) {
        if (!(error instanceof ReconciliationRequired)) throw error;
        await db.update(publishQueueTable).set({ status: "reconciliation_required", error: "Fixture: ambiguous mutation preserved." })
          .where(and(eq(publishQueueTable.id, work.id), eq(publishQueueTable.ownerId, owner!)));
        process.send!({ type: "reconciliation_required" });
      }
    }, 60000, () => {
      process.send!({ type: "error" });
      process.exitCode = 1;
      void lifecycle.stop().then(() => process.disconnect?.());
    });
  },
  drain: async () => { await stopPolling?.(); },
  closeResources: () => pool.end(),
});
process.once("SIGTERM", () => {
  process.send!({ type: "draining" });
  void lifecycle.stop().then(() => { process.disconnect?.(); }).catch(() => process.exit(1));
});
// Never leave a hanging fixture child after its test runner disappears.
process.once("disconnect", () => { if (!lifecycle.stopping) process.exit(1); });
void lifecycle.ready.then(() => {
  const address = health.address();
  assert.ok(address && typeof address !== "string");
  process.send!({ type: "listening", port: address.port });
}).catch(() => process.exit(1));
