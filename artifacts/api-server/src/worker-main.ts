import { startPipelineWorker } from "./pipeline/worker";
import { startPublisher } from "./publishing/publisher";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { createServer } from "node:http";

const stopMedia = startPipelineWorker();
const stopPublisher = startPublisher();
const health = createServer((req, res) => {
  res.writeHead(req.url === "/worker-healthz" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ running: true, scheduling: "Only while this service runs; not an uptime guarantee." }));
});
health.listen(Number(process.env.PORT ?? 8099), "0.0.0.0");
logger.info("Dedicated media worker and 60-second publisher started; only active while this service runs");
async function stop() {
  stopPublisher();
  health.close();
  logger.info("Worker draining; unfinished leases will recover after interruption");
  // Let in-flight work finish on a clean shutdown. Hard termination is lease-recoverable.
  await stopMedia();
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
