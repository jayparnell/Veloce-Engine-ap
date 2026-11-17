/**
 * Development-only browser session for an isolated synthetic owner, used when
 * the test OIDC issuer is unavailable. No auth endpoint or production bypass.
 * Session material is written privately to ignored generated output, never logged.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { createSession } from "../lib/auth";
import { workspaceRoot } from "../pipeline/paths";

const directory = join(workspaceRoot, "generated-artifacts", "storage-browser");
const path = join(directory, "session.json");
if (process.env.REPLIT_DEPLOYMENT === "1" || !process.env.REPLIT_DEV_DOMAIN) throw new Error("Development-only fixture.");
try {
  if (process.argv.includes("--cleanup")) {
    const saved = JSON.parse(await readFile(path, "utf8")) as { userId: string; owner: string; sessionId: string };
    if (!saved.userId.startsWith("storage-browser-") || saved.owner !== `user:${saved.userId}`) throw new Error("Invalid fixture");
    await pool.query("DELETE FROM sessions WHERE sid=$1 OR sess->'auth'->'user'->>'id'=$2 OR sess->'user'->>'id'=$2", [saved.sessionId, saved.userId]);
    await pool.query("DELETE FROM storage_cleanups WHERE owner_id=$1", [saved.owner]);
    await rm(path);
    process.stdout.write("Removed isolated storage browser session and fixture audit rows.\n");
  } else if (process.argv.includes("--setup")) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const userId = `storage-browser-${randomUUID()}`;
    const sessionId = await createSession({ user: { id: userId, firstName: "Storage", lastName: "Fixture", email: null, profileImageUrl: null },
      access_token: "isolated-browser-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    await writeFile(path, JSON.stringify({ userId, owner: `user:${userId}`, sessionId, origin,
      cookie: { name: "sid", value: sessionId, domain: new URL(origin).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" } }),
    { mode: 0o600, flag: "wx" });
    process.stdout.write("Created isolated browser session; read ignored generated-artifacts/storage-browser/session.json privately without logging its contents.\n");
  } else throw new Error("Pass --setup or --cleanup");
} finally { await pool.end(); }
