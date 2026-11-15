import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import type { SessionData as AuthSessionData } from "./auth";
import { SESSION_TTL } from "./auth";
import { logger } from "./logger";

declare module "express-session" {
  interface SessionData {
    auth?: AuthSessionData;
  }
}

const PgStore = connectPgSimple(session);
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required for secure browser sessions.");

export const BROWSER_COOKIE = "veloce.sid";
export const browserSessions = session({
  name: BROWSER_COOKIE,
  secret: process.env.SESSION_SECRET,
  store: new PgStore({
    pool,
    tableName: "sessions",
    createTableIfMissing: false,
    errorLog: () => logger.error("PostgreSQL session store request failed"),
  }),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: "lax", maxAge: SESSION_TTL, path: "/" },
});
