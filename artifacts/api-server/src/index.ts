import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { createServer } from "node:http";
import { serviceLifecycle, servicePort } from "./lib/service-lifecycle";

const port = servicePort();
const server = createServer(app);
const lifecycle = serviceLifecycle(server, {
  port,
  start: () => { logger.info({ port }, "Server listening"); },
  closeResources: () => pool.end(),
});
async function stop() {
  logger.info("API draining");
  await lifecycle.stop();
}
function fail(error: unknown) {
  process.exitCode = 1;
  logger.error({ err: error, port }, "API service failed");
  void stop().catch((err) => { logger.error({ err }, "API shutdown failed"); });
}
server.on("error", fail);
void lifecycle.ready.catch(fail);
process.once("SIGTERM", () => { void stop().catch(fail); });
process.once("SIGINT", () => { void stop().catch(fail); });
