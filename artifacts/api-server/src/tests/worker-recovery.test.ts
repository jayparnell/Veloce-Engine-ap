import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:net";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  pool, createDatabasePool, queueConnection, databaseFailure, QueueDatabaseError, type PoolClient,
} from "@workspace/db";
import { startPollLoop } from "../lib/poll-loop";
import { pollReadiness } from "../lib/worker-readiness";
import { runSlot, startPipelineWorker } from "../pipeline/worker";
import { publisherTick } from "../publishing/publisher";

assert.notEqual(process.env.NODE_ENV, "production");
after(() => pool.end());

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Fixture condition did not finish");
    await delay(5);
  }
}

test("authentication stalls time out without logging credentials", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Accept TCP but deliberately never answer PostgreSQL startup.
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const fixture = createDatabasePool({
    host: "127.0.0.1", port: address.port, user: "synthetic", password: "synthetic",
    database: "synthetic", ssl: false, connectionTimeoutMillis: 50,
  }, () => assert.fail("Unexpected idle database error"));
  try {
    const started = Date.now();
    await assert.rejects(queueConnection(fixture, "fixture.authentication"), (error: unknown) => {
      assert.ok(error instanceof QueueDatabaseError);
      assert.equal(error.operation, "fixture.authentication");
      assert.ok(!JSON.stringify(error).includes("synthetic"));
      return true;
    });
    assert.ok(Date.now() - started < 2000);
  } finally {
    await fixture.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("saturated acquisition removes its waiter and recovers without restarting the pool", async () => {
  const fixture = createDatabasePool({ ...pool.options, max: 1 }, () => assert.fail("Unexpected idle database error"));
  const held = await fixture.connect();
  // Warm authentication gets the normal budget. Only the saturated waiter
  // under test uses a short deadline, even when other validations load the DB.
  fixture.options.connectionTimeoutMillis = 60;
  try {
    await assert.rejects(queueConnection(fixture, "fixture.saturation"), QueueDatabaseError);
    assert.equal(fixture.waitingCount, 0);
  } finally { held.release(); }
  try {
    const recovered = await queueConnection(fixture, "fixture.recovered", 1000);
    assert.equal((await recovered.client.query("SELECT 1 AS ok")).rows[0].ok, 1);
    recovered.release();
  } finally { await fixture.end(); }
});

test("stalled safe query destroys its connection, rolls back locks, and polling recovers", async () => {
  const fixture = createDatabasePool({ ...pool.options, max: 1 }, () => assert.fail("Unexpected idle database error"));
  const readiness = pollReadiness(1000);
  let attempts = 0, failures = 0, stopping = false;
  const codes: string[] = [];
  const stop = startPollLoop(async () => {
    const session = await queueConnection(fixture, "fixture.safe_query", 250);
    try {
      attempts++;
      if (attempts === 1) {
        await session.client.query("BEGIN");
        await session.client.query("SELECT pg_advisory_xact_lock(74990, 11)");
        await session.client.query("SELECT pg_sleep(5)");
      } else {
        if (attempts === 2) assert.equal(readiness.snapshot().state, "recovering");
        assert.equal((await session.client.query("SELECT pg_try_advisory_xact_lock(74990, 11) AS ok")).rows[0].ok, true);
      }
    } finally { session.release(); }
  }, 30, (error) => {
    failures++;
    codes.push(databaseFailure(error).code);
  }, readiness.observer);
  try {
    await until(() => readiness.snapshot().ready);
    assert.equal(failures, 1);
    assert.ok(["57014", "QUEUE_QUERY_TIMEOUT"].includes(codes[0]!));
    assert.ok(attempts >= 2);
    stopping = true;
    await stop();
    const stoppedAt = attempts;
    await delay(80);
    assert.equal(attempts, stoppedAt);
  } finally {
    if (!stopping) await stop();
    await fixture.end();
  }
});

test("query deadlines do not run while a lock holder does active work; drain retains ownership", async () => {
  const fixture = createDatabasePool({ ...pool.options, max: 2 }, () => assert.fail("Unexpected idle database error"));
  const session = await queueConnection(fixture, "fixture.lock", 250);
  await session.client.query("SELECT pg_advisory_lock(74990,12)");
  const competitor = await fixture.connect();
  let entered = false;
  const stop = startPollLoop(async () => {
    entered = true;
    // Deliberately longer than the safe-query deadline, through the unwrapped holder.
    await session.raw.query("SELECT pg_sleep(0.4)");
  }, 5, assert.fail);
  try {
    await until(() => entered);
    let drained = false;
    const draining = stop().then(() => { drained = true; });
    await delay(300);
    assert.equal(drained, false);
    assert.equal((await competitor.query("SELECT pg_try_advisory_lock(74990,12) AS ok")).rows[0].ok, false);
    await draining;
    await session.client.query("SELECT pg_advisory_unlock(74990,12)");
    assert.equal((await competitor.query("SELECT pg_try_advisory_lock(74990,12) AS ok")).rows[0].ok, true);
    await competitor.query("SELECT pg_advisory_unlock(74990,12)");
  } finally {
    await stop();
    session.release();
    competitor.release();
    await fixture.end();
  }
});

test("failed slot and publisher acquisition reject safely; background slot failure cannot escape", async () => {
  const original = pool.connect;
  const readiness = pollReadiness(1000);
  let connections = 0, returned = 0;
  let refuse = false;
  pool.connect = (async () => {
    connections++;
    if (refuse || (connections >= 4 && connections <= 8)) throw Object.assign(new Error("private connection string must never be logged"), { code: "28P01" });
    const client = new EventEmitter() as PoolClient;
    client.query = (async () => ({ rows: [], rowCount: 0 })) as unknown as PoolClient["query"];
    client.release = () => { returned++; };
    return client;
  }) as typeof pool.connect;
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = startPipelineWorker(readiness.observer);
    await until(() => readiness.snapshot().state === "unavailable");
    assert.equal(returned, 3);
    assert.ok(connections >= 8, "All background slot acquisition rejections were observed");
    await until(() => readiness.snapshot().ready);
    await stop();
    refuse = true;
    await assert.rejects(runSlot(0, async () => assert.fail("No paid work")), QueueDatabaseError);
    await assert.rejects(publisherTick(() => false, async () => assert.fail("No provider work")), QueueDatabaseError);
  } finally {
    await stop?.();
    pool.connect = original;
  }
});

test("unresponsive safe-query socket is discarded; late rejection is handled and shutdown finishes", async () => {
  const raw = new EventEmitter() as PoolClient;
  let destroyed = 0, finish!: (error: Error) => void;
  raw.query = (async (text: string) => {
    if (text.startsWith("SET ")) return { rows: [] };
    return new Promise((_resolve, reject) => { finish = reject; });
  }) as unknown as PoolClient["query"];
  raw.release = (destroy) => { if (destroy) destroyed++; };
  const source = { connect: async () => raw } as unknown as typeof pool;
  const readiness = pollReadiness(1000);
  let failures = 0;
  const stop = startPollLoop(async () => {
    const session = await queueConnection(source, "fixture.socket", 30);
    try { await session.client.query("SELECT 1"); }
    finally { session.release(); }
  }, 1000, () => { failures++; }, readiness.observer);
  await until(() => readiness.snapshot().polling);
  // Stop while the safe query is still stalled, not only after recovery.
  await stop();
  assert.equal(failures, 1);
  assert.equal(destroyed, 1);
  assert.equal(readiness.snapshot().state, "unavailable");
  finish(new Error("Late socket termination"));
  await delay(5);
});

test("idle errors are handled with allowlisted diagnostics, never server messages or private fields", async () => {
  const seen: unknown[] = [];
  const fixture = createDatabasePool({}, (details) => seen.push(details));
  try {
    fixture.emit("error", Object.assign(new Error("postgresql://private:secret@host/private"), {
      code: "28P01", detail: "private job", name: "private",
    }));
    assert.deepEqual(seen, [{ code: "28P01" }]);
    assert.deepEqual(databaseFailure({ code: "PRIVATE_TOKEN" }), { code: "DATABASE_UNAVAILABLE" });
  } finally { await fixture.end(); }
});
