import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startPollLoop } from "../lib/poll-loop";
import { pollReadiness, workerReadiness } from "../lib/worker-readiness";

test("listener startup is not ready before both queue polls succeed", () => {
  const health = workerReadiness(() => 100);
  assert.equal(health.response(false).status, 503);
  health.media.observer.started();
  health.media.observer.succeeded();
  assert.equal(health.response(false).status, 503);
  health.publisher.observer.started();
  health.publisher.observer.succeeded();
  assert.equal(health.response(false).status, 200);
});

test("a failed poll degrades readiness immediately and a successful poll recovers", () => {
  let clock = 100;
  const health = workerReadiness(() => clock);
  health.media.observer.succeeded();
  health.publisher.observer.succeeded();
  clock = 200;
  health.publisher.observer.failed();
  const failed = health.response(false);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.polls.publisher.state, "unavailable");
  assert.equal(failed.body.polls.publisher.lastSuccessAt, 100);
  assert.equal(failed.body.polls.publisher.lastFailureAt, 200);
  clock = 300;
  health.publisher.observer.succeeded();
  assert.equal(health.response(false).status, 200);
  assert.equal(health.response(false).body.polls.publisher.error, null);
});

test("repeated starts cannot hide a hung or never-successful poll", () => {
  let clock = 0;
  const poll = pollReadiness(30000, () => clock);
  poll.observer.started();
  clock = 30001;
  assert.equal(poll.snapshot().state, "stale");
  poll.observer.started();
  assert.equal(poll.snapshot().state, "stale");
  poll.observer.succeeded();
  assert.equal(poll.snapshot().state, "ready");
  clock += 30001;
  assert.equal(poll.snapshot().state, "stale");
});

test("publisher allows its existing 60-second cadence but expires after 150 seconds", () => {
  let clock = 0;
  const health = workerReadiness(() => clock);
  health.publisher.observer.succeeded();
  clock = 60000;
  assert.equal(health.publisher.snapshot().ready, true);
  clock = 150001;
  assert.equal(health.publisher.snapshot().state, "stale");
});

test("draining is distinguished from queue unavailability without clearing successful polls", () => {
  const health = workerReadiness(() => 123);
  health.media.observer.succeeded();
  health.publisher.observer.succeeded();
  const draining = health.response(true);
  assert.equal(draining.status, 503);
  assert.equal(draining.body.state, "draining");
  assert.equal(draining.body.running, false);
  assert.equal(draining.body.polls.media.state, "ready");
});

test("simulated database outage reaches HTTP readiness without leaking its exception", async () => {
  const health = workerReadiness();
  health.publisher.observer.succeeded();
  const server = createServer((_req, res) => {
    const snapshot = health.response(false);
    res.writeHead(snapshot.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot.body));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let fail = true;
  let errors = 0;
  const stop = startPollLoop(async () => {
    if (fail) throw new Error("postgres://private:secret@example.test/jobs owner=private-user");
  }, 5, () => { errors++; }, health.media.observer);
  const waitFor = async (condition: () => boolean) => {
    for (let n = 0; n < 100 && !condition(); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), "poll did not reach expected state");
  };
  try {
    await waitFor(() => errors > 0);
    const url = `http://127.0.0.1:${address.port}/worker-healthz`;
    const failed = await fetch(url);
    assert.equal(failed.status, 503);
    const body = await failed.text();
    for (const sensitive of ["postgres://", "secret", "private-user", "example.test"]) assert.ok(!body.includes(sensitive));
    fail = false;
    await waitFor(() => health.response(false).status === 200);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await stop();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test("stop before the first tick neither runs nor reports a successful queue poll", async () => {
  const readiness = pollReadiness(30000);
  let calls = 0;
  await startPollLoop(async () => { calls++; }, 2000, assert.fail, readiness.observer)();
  assert.equal(calls, 0);
  assert.equal(readiness.snapshot().lastSuccessAt, null);
});
