import { Router, type IRouter, type Request } from "express";
import { randomBytes, createHash, createCipheriv } from "node:crypto";
import { db, socialConfigsTable, oauthStatesTable, platformAccountsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import { GetSocialIntegrationsResponse, SaveSocialIntegrationBody, SaveSocialIntegrationParams, SaveSocialIntegrationResponse, DisconnectSocialIntegrationParams } from "@workspace/api-zod";

const router: IRouter = Router();
const providers = {
  youtube: {
    name: "YouTube Data API v3", platform: "YouTube Shorts",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    secretName: "GOOGLE_CLIENT_SECRET", apiKeyName: "YOUTUBE_API_KEY",
    scopes: "https://www.googleapis.com/auth/youtube.upload",
  },
  tiktok: {
    name: "TikTok Content Posting API", platform: "TikTok",
    authorize: "https://www.tiktok.com/v2/auth/authorize/", token: "https://open.tiktokapis.com/v2/oauth/token/",
    secretName: "TIKTOK_CLIENT_SECRET", apiKeyName: "",
    scopes: "video.publish,video.upload",
  },
} as const;
type Provider = keyof typeof providers;
function providerOf(value: unknown): Provider | null { return value === "youtube" || value === "tiktok" ? value : null; }
function redirectUri(req: Request, provider: Provider) {
  const rawHost = req.get("x-forwarded-host") || req.get("host") || "";
  if (!/^[a-zA-Z0-9.:-]+$/.test(rawHost)) throw new Error("Invalid request host");
  return `https://${rawHost}/api/social/oauth/${provider}/callback`;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function encryptTokens(value: unknown) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Session encryption is not configured");
  const iv = randomBytes(12);
  const key = createHash("sha256").update(`veloce-social:${secret}`).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((p) => p.toString("base64url")).join(".");
}
async function publicConfig(req: Request, provider: Provider) {
  const meta = providers[provider];
  const [saved] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
  const secretConfigured = Boolean(process.env[meta.secretName]);
  const connected = Boolean(saved?.encryptedTokens);
  const canConnect = Boolean(req.isAuthenticated() && saved?.clientId && saved.appApproved && secretConfigured && process.env.SESSION_SECRET);
  return {
    provider, name: meta.name, clientId: saved?.clientId ?? "", appApproved: saved?.appApproved ?? false,
    redirectUri: redirectUri(req, provider), scopes: meta.scopes, secretName: meta.secretName, secretConfigured,
    apiKeyName: meta.apiKeyName, apiKeyConfigured: Boolean(meta.apiKeyName && process.env[meta.apiKeyName]),
    connected, canConnect,
    message: connected ? "Account authorized. Automatic posting is not enabled; scheduled entries remain drafts."
      : !req.isAuthenticated() ? "Log in to configure your account."
      : !saved?.clientId ? "Save your public client ID and register this callback URL with the platform."
      : !secretConfigured ? `Add ${meta.secretName} in this project's Tools > Secrets. Never paste it into this page.`
      : !saved.appApproved ? "Confirm your app and posting scopes are approved, then authorize your account."
      : "Ready for account authorization. No videos will be posted by connecting.",
  };
}
router.get("/settings/integrations", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  res.json(GetSocialIntegrationsResponse.parse(await Promise.all((["youtube", "tiktok"] as Provider[]).map((p) => publicConfig(req, p)))));
});
router.put("/settings/integrations/:provider", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to configure integrations." }); return; }
  const params = SaveSocialIntegrationParams.safeParse(req.params);
  const parsed = SaveSocialIntegrationBody.safeParse(req.body);
  if (!params.success || !parsed.success || /[\s<>]/.test(parsed.data.clientId.trim())) { res.status(400).json({ error: "Enter a valid public OAuth client identifier." }); return; }
  const provider = params.data.provider;
  const [old] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
  const values = { ...parsed.data, clientId: parsed.data.clientId.trim() };
  const changed = old?.clientId !== values.clientId;
  await db.insert(socialConfigsTable).values({ ...values, ownerId: req.workspaceId, provider }).onConflictDoUpdate({
    target: [socialConfigsTable.ownerId, socialConfigsTable.provider],
    set: { ...values, ...(changed ? { encryptedTokens: null, expiresAt: null } : {}) },
  });
  if (changed) await db.update(platformAccountsTable).set({ connected: false, handle: "" }).where(and(eq(platformAccountsTable.ownerId, req.workspaceId), eq(platformAccountsTable.platform, providers[provider].platform)));
  res.json(SaveSocialIntegrationResponse.parse(await publicConfig(req, provider)));
});
router.delete("/settings/integrations/:provider", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to disconnect an account." }); return; }
  const params = DisconnectSocialIntegrationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid provider." }); return; }
  const provider = params.data.provider;
  await db.update(socialConfigsTable).set({ encryptedTokens: null, expiresAt: null }).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
  await db.delete(oauthStatesTable).where(and(eq(oauthStatesTable.ownerId, req.workspaceId), eq(oauthStatesTable.provider, provider)));
  await db.update(platformAccountsTable).set({ connected: false, handle: "" }).where(and(eq(platformAccountsTable.ownerId, req.workspaceId), eq(platformAccountsTable.platform, providers[provider].platform)));
  res.sendStatus(204);
});

router.get("/social/oauth/:provider/start", async (req, res): Promise<void> => {
  const provider = providerOf(req.params.provider);
  if (!provider) { res.status(404).json({ error: "Provider not supported." }); return; }
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in first." }); return; }
  const config = await publicConfig(req, provider);
  if (!config.canConnect) { res.status(409).json({ error: config.message }); return; }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  await db.delete(oauthStatesTable).where(lt(oauthStatesTable.expiresAt, new Date()));
  await db.insert(oauthStatesTable).values({ stateHash: hash(state), ownerId: req.workspaceId, provider, verifier, redirectUri: config.redirectUri, expiresAt: new Date(Date.now() + 600000) });
  const url = new URL(providers[provider].authorize);
  url.searchParams.set(provider === "youtube" ? "client_id" : "client_key", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  if (provider === "youtube") {
    url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  res.redirect(url.toString());
});
router.get("/social/oauth/:provider/callback", async (req, res): Promise<void> => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const provider = providerOf(req.params.provider);
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!provider || !state || !req.isAuthenticated()) { res.redirect("/settings?oauth=failed"); return; }
  const [savedState] = await db.delete(oauthStatesTable).where(and(eq(oauthStatesTable.stateHash, hash(state)), eq(oauthStatesTable.ownerId, req.workspaceId), eq(oauthStatesTable.provider, provider))).returning();
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!savedState || savedState.expiresAt < new Date() || !code || req.query.error) { res.redirect("/settings?oauth=failed"); return; }
  try {
    const config = await publicConfig(req, provider);
    if (!config.canConnect) throw new Error("Configuration changed");
    const meta = providers[provider];
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: savedState.redirectUri, client_secret: process.env[meta.secretName]! });
    body.set(provider === "youtube" ? "client_id" : "client_key", config.clientId);
    if (provider === "youtube") body.set("code_verifier", savedState.verifier);
    const response = await fetch(meta.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30000) });
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: unknown };
    const granted = (token.scope ?? "").split(/[,\s]+/);
    if (!response.ok || !token.access_token || token.error || !config.scopes.split(/[,\s]+/).every((s) => granted.includes(s))) throw new Error("Authorization or required scopes rejected");
    await db.update(socialConfigsTable).set({ encryptedTokens: encryptTokens(token), expiresAt: new Date(Date.now() + Math.max(0, Number(token.expires_in ?? 3600)) * 1000) }).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
    await db.update(platformAccountsTable).set({ connected: true, handle: "Authorized account" }).where(and(eq(platformAccountsTable.ownerId, req.workspaceId), eq(platformAccountsTable.platform, meta.platform)));
    res.redirect("/settings?oauth=connected");
  } catch {
    req.log.warn({ provider }, "Social authorization could not be completed");
    res.redirect("/settings?oauth=failed");
  }
});
export default router;
