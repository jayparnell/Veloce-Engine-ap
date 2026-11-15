import type { AuthStateUser } from '@workspace/api-zod';
type AuthUser = NonNullable<AuthStateUser>;
import { type NextFunction, type Request, type Response } from 'express';
import * as oidc from 'openid-client';

import {
  clearSession,
  getOidcConfig,
  getSession,
  getSessionId,
  updateSession,
  type SessionData,
} from '../lib/auth';

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

async function refreshIfExpired(
  sid: string | undefined,
  session: SessionData,
): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;

  if (!session.refresh_token) return null;

  try {
    const config = await getOidcConfig();
    const tokens = await oidc.refreshTokenGrant(config, session.refresh_token);
    session.access_token = tokens.access_token;
    session.refresh_token = tokens.refresh_token ?? session.refresh_token;
    session.expires_at = tokens.expiresIn()
      ? now + tokens.expiresIn()!
      : session.expires_at;
    if (sid) await updateSession(sid, session);
    return session;
  } catch {
    return null;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request['isAuthenticated'];

  const browserAuth = req.session?.auth;
  const sid = getSessionId(req);
  if (!browserAuth && !sid) {
    next();
    return;
  }

  const session = browserAuth ?? await getSession(sid!);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    if (req.session?.auth) await new Promise<void>((resolve, reject) => req.session.destroy((err) => err ? reject(err) : resolve()));
    next();
    return;
  }

  const refreshed = await refreshIfExpired(browserAuth ? undefined : sid, session);
  if (!refreshed) {
    await clearSession(res, sid);
    if (req.session?.auth) await new Promise<void>((resolve, reject) => req.session.destroy((err) => err ? reject(err) : resolve()));
    next();
    return;
  }

  req.user = refreshed.user;
  if (req.session && !req.headers.authorization && (!browserAuth || refreshed !== browserAuth || session.expires_at !== browserAuth.expires_at)) {
    req.session.auth = refreshed;
  }
  next();
}
