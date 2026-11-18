import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { createDatabasePool, queueConnection, QueueDatabaseError } from "./recovery";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = createDatabasePool({ connectionString: process.env.DATABASE_URL }, (details) => {
  console.error(JSON.stringify({ operation: "database.idle_client", ...details }));
});
export const db = drizzle(pool, { schema });

/** Restricted to database-only, repeatable queue bookkeeping. */
export type QueueDatabase = NodePgDatabase<typeof schema>;
export async function withQueueDatabase<T>(operation: string, task: (database: QueueDatabase) => Promise<T>) {
  const connection = await queueConnection(pool, operation);
  try { return await task(drizzle(connection.client, { schema })); }
  catch (cause) { throw new QueueDatabaseError(operation, cause); }
  finally { connection.release(); }
}
export * from "./recovery";
export * from "./schema";
export type { PoolClient } from "pg";
