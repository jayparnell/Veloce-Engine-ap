import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { db, pool, sessionsTable, autopilotJobsTable, projectsTable, autopilotAdmissionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// Test-only API exercise through the shared proxy. No source downloads, AI, or social posts.
const owners: string[] = [], sessions: string[] = [];
const batchSize = Number(process.argv[2] ?? 1);
if (![1, 5].includes(batchSize)) throw new Error("Use a batch size of 1 or 5.");
const requestsPerUser = 20 / batchSize;
const handler: number[] = [], roundtrip: number[] = [];
const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
try {
  const guest = await fetch("http://localhost:80/api/autopilot/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources: ["https://youtu.be/fixture"], idempotencyKey: randomUUID() }) });
  if (guest.status !== 401) throw new Error("Signed-out processing must fail with 401");
  let requestIndex = 0;
  for (let user = 0; user < 6 * batchSize; user++) {
    const id = `acceptance-benchmark-${randomUUID()}`, owner = `user:${id}`;
    owners.push(owner);
    const session = randomUUID();
    await db.insert(sessionsTable).values({ sid: session, sess: { user: { id, email: null, firstName: "Verification", lastName: null, profileImageUrl: null }, access_token: "synthetic-non-provider-test-session" }, expire: new Date(Date.now() + 3600000) });
    sessions.push(session);
    for (let i = 0; i < requestsPerUser; i++, requestIndex++) {
      const key = randomUUID(), start = performance.now();
      const request = { sources: Array.from({ length: batchSize }, (_, n) => `https://youtu.be/authorized-verification-fixture-${n}`), idempotencyKey: key };
      const response = await fetch("http://localhost:80/api/autopilot/launch", { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const data = await response.json() as { acceptedMs: number; jobIds: number[]; error?: string };
      if (response.status !== 202) throw new Error(`Unexpected acceptance status ${response.status}: ${data.error}`);
      const elapsed = performance.now() - start;
      // The worker is stopped during this benchmark. Immediately cancel each accepted fixture.
      await db.update(autopilotJobsTable).set({ status: "cancelled", cancelRequested: true }).where(inArray(autopilotJobsTable.id, data.jobIds));
      if (requestIndex >= 20) { handler.push(data.acceptedMs); roundtrip.push(elapsed); }
      if (i === 0) {
        const replay = await fetch("http://localhost:80/api/autopilot/launch", { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
        const repeated = await replay.json() as { jobIds: number[] };
        if (JSON.stringify(repeated.jobIds) !== JSON.stringify(data.jobIds)) throw new Error("Idempotent acceptance duplicated jobs");
      }
    }
  }
  const report = { samples: handler.length, warmup: 20, batchSize, parallelRequests: 1, handlerMs: { p50: percentile(handler, .5), p95: percentile(handler, .95) }, localProxyRoundtripMs: { p50: percentile(roundtrip, .5), p95: percentile(roundtrip, .95) },
    conditions: `Warm development API + existing local PostgreSQL pool; 20 warmups, then 100 fresh durable accepts; ${6 * batchSize} isolated users total, sequential ${batchSize}-source HTTPS-link batches; bearer-session auth; shared localhost:80 proxy, worker stopped. Handler timing excludes auth middleware; proxy roundtrip includes auth and JSON. No downloads, AI calls, cold-start, WAN or production latency claims.` };
  await mkdir("../generated-artifacts/verification", { recursive: true });
  await writeFile(`../generated-artifacts/verification/acceptance-latency-batch${batchSize}.json`, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  for (const owner of owners) {
    await db.delete(projectsTable).where(eq(projectsTable.ownerId, owner));
    await db.delete(autopilotAdmissionsTable).where(eq(autopilotAdmissionsTable.ownerId, owner));
  }
  if (sessions.length) await db.delete(sessionsTable).where(inArray(sessionsTable.sid, sessions));
  await pool.end();
}
