import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const connection = await pool.connect();
try {
  await connection.query("BEGIN");
  await connection.query("SELECT pg_advisory_xact_lock(74005,0)");
  const migration = await readFile(new URL("../migrations/20261116_autopilot.sql", import.meta.url), "utf8");
  await connection.query(migration);
  await connection.query(await readFile(new URL("../migrations/20261116_render_guardrails.sql", import.meta.url), "utf8"));
  await connection.query("COMMIT");
} catch (error) {
  await connection.query("ROLLBACK");
  throw error;
} finally {
  connection.release();
  await pool.end();
}
