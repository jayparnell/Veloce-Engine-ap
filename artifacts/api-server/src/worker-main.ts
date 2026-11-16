import { startPipelineWorker } from "./pipeline/worker";
import { startPublisher } from "./publishing/publisher";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { createServer } from "node:http";
import { serviceLifecycle, servicePort } from "./lib/service-lifecycle";

const port = servicePort();
let stopMedia: (() => Promise<void>) | undefined;
let stopPublisher: (() => Promise<void>) | undefined;
const health = createServer((req, res) => {
  res.writeHead(req.url !== "/worker-healthz" ? 404 : lifecycle.stopping ? 503 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ running: !lifecycle.stopping, scheduling: "Only while this service runs; not an uptime guarantee." }));
});
const lifecycle = serviceLifecycle(health, {
  port,
  start: () => {
    stopMedia = startPipelineWorker();
    stopPublisher = startPublisher();
    logger.info({ port }, "Dedicated media worker and 60-second publisher started; only active while this service runs");
  },
  drain: async () => {
    // Invoke both stops before waiting, so neither loop can claim more work.
    await Promise.all([stopMedia?.(), stopPublisher?.()]);
  },
  closeResources: () => pool.end(),
});
async function stop() {
  logger.info("Worker draining; unfinished leases will recover after interruption");
  await lifecycle.stop();
}
function fail(error: unknown) {
  process.exitCode = 1;
  logger.error({ err: error, port }, "Worker service failed");
  void stop().catch((err) => { logger.error({ err }, "Worker shutdown failed"); });
}
health.on("error", fail);
void lifecycle.ready.catch(fail);
process.once("SIGTERM", () => { void stop().catch(fail); });
process.once("SIGINT", () => { void stop().catch(fail); });
