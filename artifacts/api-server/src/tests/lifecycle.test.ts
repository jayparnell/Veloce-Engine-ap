import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serviceLifecycle, servicePort } from "../lib/service-lifecycle";
import { startPollLoop } from "../lib/poll-loop";
import { setTimeout as delay } from "node:timers/promises";

test("ports reject missing, fractional and out-of-range values", () => {
  for (const port of ["", "0", "-1", "65536", "8080.5", "bad"]) {
    assert.throws(() => servicePort(port));
  }
  assert.equal(servicePort("8099"), 8099);
});

test("binding precedes work; duplicate bind starts no work; draining retains ownership", async () => {
  const server = createServer();
  let started = 0, cleaned = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const lifecycle = serviceLifecycle(server, {
    port: 0, start: () => { assert.equal(server.listening, true); started++; },
    drain: () => pending, closeResources: async () => { cleaned++; },
  });
  await lifecycle.ready;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const duplicate = serviceLifecycle(createServer(), {
    port: address.port, start: () => { started++; }, closeResources: async () => {},
  });
  await assert.rejects(duplicate.ready, { code: "EADDRINUSE" });
  await duplicate.stop();
  assert.equal(started, 1);
  const stopping = lifecycle.stop();
  assert.equal(lifecycle.stop(), stopping);
  await delay(5);
  assert.equal(server.listening, true);
  assert.equal(cleaned, 0);
  release();
  await stopping;
  assert.equal(server.listening, false);
  assert.equal(cleaned, 1);
  const replacement = serviceLifecycle(createServer(), {
    port: address.port, closeResources: async () => {},
  });
  await replacement.ready;
  await replacement.stop();
});

test("stop during bind never starts polling", async () => {
  let started = false;
  const lifecycle = serviceLifecycle(createServer(), {
    port: 0, start: () => { started = true; }, closeResources: async () => {},
  });
  await lifecycle.stop();
  assert.equal(started, false);
});

test("poll shutdown waits for in-flight work without overlapping or claiming again", async () => {
  let calls = 0, drained = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const stop = startPollLoop(async () => { calls++; await pending; }, 1, assert.fail);
  await delay(10);
  assert.equal(calls, 1);
  const stopping = stop().then(() => { drained = true; });
  await delay(5);
  assert.equal(drained, false);
  release();
  await stopping;
  await delay(5);
  assert.equal(calls, 1);
});

test("first poll rejection is handled and immediate stop prevents first poll", async () => {
  let errors = 0, calls = 0;
  const stop = startPollLoop(async () => { throw new Error("fixture"); }, 60000, () => { errors++; });
  await delay(5);
  await stop();
  assert.equal(errors, 1);
  await startPollLoop(async () => { calls++; }, 60000, assert.fail)();
  assert.equal(calls, 0);
});

test("poll error callbacks cannot escape as an unhandled rejection", async () => {
  let errors = 0;
  const stop = startPollLoop(async () => { throw new Error("fixture"); }, 5, () => {
    errors++;
    throw new Error("diagnostic fixture");
  });
  await delay(40);
  await stop();
  assert.ok(errors >= 2);
});
