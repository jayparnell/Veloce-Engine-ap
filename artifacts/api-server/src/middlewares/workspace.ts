import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { seedWorkspace } from "../lib/demo";

declare global {
  namespace Express {
    interface Request { workspaceId: string }
  }
}
const initialized = new Map<string, number>();
export const workspaceMiddleware: RequestHandler = async (req, res, next) => {
  if (req.path === "/healthz" || req.path.startsWith("/auth/") || req.path === "/login" || req.path === "/callback" || req.path === "/logout") {
    next(); return;
  }
  let visitor = req.cookies?.ve_workspace;
  if (typeof visitor !== "string" || !/^[0-9a-f-]{36}$/.test(visitor)) {
    visitor = randomUUID();
    res.cookie("ve_workspace", visitor, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 86400000 });
  }
  req.workspaceId = req.isAuthenticated() ? `user:${req.user.id}` : `guest:${visitor}`;
  try {
    if (!initialized.has(req.workspaceId)) {
      await seedWorkspace(req.workspaceId);
      if (initialized.size > 5000) initialized.clear();
      initialized.set(req.workspaceId, Date.now());
    }
    next();
  } catch (error) { next(error); }
};
