import type { Server } from "node:http";

export function servicePort(rawPort = process.env.PORT): number {
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

/** Retain listener ownership while work drains; never start work on a failed bind. */
export function serviceLifecycle(server: Server, options: {
  port: number;
  start?: () => void;
  drain?: () => Promise<void>;
  closeResources: () => Promise<void>;
}) {
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).then(() => {
    if (!stopping) options.start?.();
  });
  return {
    ready,
    get stopping() { return stopping; },
    stop() {
      stopping = true;
      shutdown ??= (async () => {
        await ready.catch(() => {});
        try {
          await options.drain?.();
        } finally {
          try {
            if (server.listening) await new Promise<void>((resolve, reject) => {
              server.close((error) => error ? reject(error) : resolve());
              server.closeIdleConnections();
            });
          } finally {
            await options.closeResources();
          }
        }
      })();
      return shutdown;
    },
  };
}
