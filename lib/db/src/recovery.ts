import pg from "pg";

export const CONNECTION_WAIT_MS = 5000;
export const SAFE_QUERY_WAIT_MS = 10000;

/** Deliberately exclude messages, detail, SQL, parameters, hosts and arbitrary error names. */
export function databaseFailure(error: unknown) {
  let current = error as { code?: unknown; cause?: unknown; phase?: unknown } | null;
  for (let depth = 0; depth < 4 && current && !current.code; depth++) {
    current = current.cause as typeof current;
  }
  const code = current?.code;
  return {
    code: typeof code === "string" && /^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|QUEUE_QUERY_TIMEOUT)$/.test(code)
      ? code : "DATABASE_UNAVAILABLE",
    ...(current?.phase === "acquire" || current?.phase === "query" || current?.phase === "connection"
      ? { phase: current.phase } : {}),
  };
}

export function createDatabasePool(config: pg.PoolConfig, onIdleError: (details: ReturnType<typeof databaseFailure>) => void) {
  // pg-pool bounds both new authentication and waiters queued behind checked-out clients.
  // No global query timeout: transactions, session locks and provider effects keep their ownership.
  const result = new pg.Pool({ ...config, connectionTimeoutMillis: config.connectionTimeoutMillis ?? CONNECTION_WAIT_MS });
  result.on("error", (error) => { onIdleError(databaseFailure(error)); });
  return result;
}

/**
 * Only for short, repeatable queue bookkeeping, never provider/AI calls or their
 * checkpoints. A timeout destroys the socket rather than leaving an orphan query
 * running on a reusable connection. The server rolls back any open transaction.
 */
export async function queueConnection(source: pg.Pool, operation: string, waitMs = SAFE_QUERY_WAIT_MS) {
  let raw: pg.PoolClient;
  try { raw = await source.connect(); }
  catch (cause) { throw new QueueDatabaseError(operation, cause, "acquire"); }
  let released = false;
  let broken = false;
  let failure: QueueDatabaseError | undefined;
  let rejectActive: ((error: unknown) => void) | undefined;
  const onError = (cause: unknown) => {
    broken = true;
    failure ??= new QueueDatabaseError(operation, cause, "connection");
    rejectActive?.(failure);
  };
  raw.on("error", onError);
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    raw.release(destroy || broken);
    // Keep the listener on destroyed clients until the socket closes.
    if (!destroy && !broken) raw.removeListener("error", onError);
  };
  const safeQuery = async (...args: unknown[]) => {
    if (released || broken) throw failure ?? new QueueDatabaseError(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        rejectActive = reject;
        timer = setTimeout(() => {
          broken = true;
          failure ??= new QueueDatabaseError(operation, { code: "QUEUE_QUERY_TIMEOUT" });
          release(true);
          reject(failure);
        }, waitMs);
        // A server deadline normally cancels first, releasing row/transaction
        // locks promptly. The socket watchdog also covers an unresponsive server.
        // Reset before returning: raw lock holders never inherit this deadline.
        const execute = async () => {
          await raw.query(`SET statement_timeout = ${Math.max(1, Math.floor(waitMs * 0.8))}`);
          if (released || broken) throw failure ?? new QueueDatabaseError(operation);
          const result = await (raw.query as (...args: unknown[]) => Promise<unknown>).apply(raw, args);
          await raw.query("RESET statement_timeout");
          return result;
        };
        void execute().then(resolve, reject);
      });
    } catch (cause) {
      broken = true;
      failure ??= cause instanceof QueueDatabaseError ? cause : new QueueDatabaseError(operation, cause);
      throw failure;
    } finally {
      clearTimeout(timer);
      rejectActive = undefined;
    }
  };
  const client = new Proxy(raw, {
    get(target, key) {
      if (key === "query") return safeQuery;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client, raw, release };
}

export class QueueDatabaseError extends Error {
  readonly code: string;
  constructor(readonly operation: string, cause?: unknown, readonly phase: "acquire" | "query" | "connection" = "query") {
    super("Queue database operation unavailable");
    this.name = "QueueDatabaseError";
    this.code = databaseFailure(cause).code;
  }
}
