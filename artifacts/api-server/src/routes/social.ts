import { Router, type IRouter, type Request } from "express";
import { randomBytes, createHash } from "node:crypto";
import { db, socialConfigsTable, oauthStatesTable, platformAccountsTable, socialAccountsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import { GetSocialIntegrationsResponse, SaveSocialIntegrationBody, SaveSocialIntegrationParams, SaveSocialIntegrationResponse, DisconnectSocialIntegrationParams } from "@workspace/api-zod";
import { PROVIDERS as providers, providerOf, type Provider, type Token, hash, encryptTokens, identifyAccount, readJson, tokenHeaders } from "../publishing/providers";
import { PRESETS } from "../publishing/slots";

const router: IRouter = Router();
function redirectUri(req: Request, provider: Provider) {
  const rawHost = req.get("x-forwarded-host") || req.get("host") || "";
  if (!/^[a-zA-Z0-9.:-]+$/.test(rawHost)) throw new Error("Invalid request host");
  return `https://${rawHost}/api/social/oauth/${provider}/callback`;
}
async function publicConfig(req: Request, provider: Provider) {
  const meta = providers[provider];
  const [saved] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
  const connectedAccounts = await db.select({ id: socialAccountsTable.id }).from(socialAccountsTable).where(and(eq(socialAccountsTable.ownerId, req.workspaceId), eq(socialAccountsTable.provider, provider), eq(socialAccountsTable.postingRoute, "direct"), eq(socialAccountsTable.connected, true)));
  const secretConfigured = Boolean(process.env[meta.secretName]);
  const connected = connectedAccounts.length > 0;
  const canConnect = Boolean(req.isAuthenticated() && saved?.clientId && saved.appApproved && secretConfigured && process.env.SESSION_SECRET);
  return {
    provider, name: meta.name, clientId: saved?.clientId ?? "", appApproved: saved?.appApproved ?? false,
    redirectUri: redirectUri(req, provider), scopes: meta.scopes, secretName: meta.secretName, secretConfigured,
    apiKeyName: meta.apiKeyName, apiKeyConfigured: Boolean(meta.apiKeyName && process.env[meta.apiKeyName]),
    connected, canConnect,
    message: !req.isAuthenticated() ? "Log in to configure your accounts."
      : !saved?.clientId ? "Save your public client identifier and register this callback with the provider. Existing legacy authorizations require reauthorization for separate accounts and posting scopes."
      : !secretConfigured ? `Configure ${meta.secretName} securely in project Secrets. Never paste secrets into this page.`
      : !saved.appApproved ? "Obtain provider approval or permitted test access for these scopes. Approval cannot be bypassed."
      : connected ? `${connectedAccounts.length} separately authorized account(s). Connecting never enables automatic posting.`
      : "Ready to authorize an account. Platform review, plan access and account restrictions still apply.",
  };
}
router.get("/settings/integrations", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  res.json(GetSocialIntegrationsResponse.parse(await Promise.all((Object.keys(providers) as Provider[]).map((p) => publicConfig(req, p)))));
});
router.put("/settings/integrations/:provider", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to configure integrations." }); return; }
  const params = SaveSocialIntegrationParams.safeParse(req.params), parsed = SaveSocialIntegrationBody.safeParse(req.body);
  if (!params.success || !parsed.success || /[\s<>]/.test(parsed.data.clientId.trim())) { res.status(400).json({ error: "Enter a valid public OAuth client identifier." }); return; }
  const provider = params.data.provider;
  const [old] = await db.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
  const values = { ...parsed.data, clientId: parsed.data.clientId.trim() }, changed = old?.clientId !== parsed.data.clientId.trim();
  await db.transaction(async (tx) => {
    await tx.insert(socialConfigsTable).values({ ...values, ownerId: req.workspaceId, provider }).onConflictDoUpdate({
      target: [socialConfigsTable.ownerId, socialConfigsTable.provider], set: { ...values, ...(changed ? { encryptedTokens: null, expiresAt: null } : {}) },
    });
    if (changed || !values.appApproved) await tx.update(socialAccountsTable).set({
      approved: values.appApproved, autoEnabled: false, ...(changed ? { connected: false, encryptedTokens: null, error: "Application identifier changed. Reauthorize this account." } : {}),
    }).where(and(eq(socialAccountsTable.ownerId, req.workspaceId), eq(socialAccountsTable.provider, provider), eq(socialAccountsTable.postingRoute, "direct")));
  });
  res.json(SaveSocialIntegrationResponse.parse(await publicConfig(req, provider)));
});
router.delete("/settings/integrations/:provider", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to disconnect accounts." }); return; }
  const params = DisconnectSocialIntegrationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid provider." }); return; }
  const provider = params.data.provider;
  await db.transaction(async (tx) => {
    await tx.update(socialConfigsTable).set({ encryptedTokens: null, expiresAt: null }).where(and(eq(socialConfigsTable.ownerId, req.workspaceId), eq(socialConfigsTable.provider, provider)));
    await tx.delete(oauthStatesTable).where(and(eq(oauthStatesTable.ownerId, req.workspaceId), eq(oauthStatesTable.provider, provider)));
    await tx.update(socialAccountsTable).set({ connected: false, autoEnabled: false, encryptedTokens: null }).where(and(eq(socialAccountsTable.ownerId, req.workspaceId), eq(socialAccountsTable.provider, provider), eq(socialAccountsTable.postingRoute, "direct")));
    await tx.update(platformAccountsTable).set({ connected: false, handle: "" }).where(and(eq(platformAccountsTable.ownerId, req.workspaceId), eq(platformAccountsTable.platform, providers[provider].platform)));
  });
  res.sendStatus(204);
});
router.get("/social/oauth/:provider/start", async (req, res): Promise<void> => {
  const provider = providerOf(req.params.provider);
  if (!provider) { res.status(404).json({ error: "Provider not supported." }); return; }
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in first." }); return; }
  const config = await publicConfig(req, provider);
  if (!config.canConnect) { res.status(409).json({ error: config.message }); return; }
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  await db.delete(oauthStatesTable).where(lt(oauthStatesTable.expiresAt, new Date()));
  await db.insert(oauthStatesTable).values({ stateHash: hash(state), ownerId: req.workspaceId, provider, verifier, redirectUri: config.redirectUri, expiresAt: new Date(Date.now() + 600000) });
  const url = new URL(providers[provider].authorize);
  url.searchParams.set(provider === "tiktok" ? "client_key" : "client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", config.scopes); url.searchParams.set("state", state);
  if (provider === "youtube" || provider === "x") {
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); url.searchParams.set("code_challenge_method", "S256");
  }
  if (provider === "youtube") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent select_account"); }
  if (provider === "instagram") url.searchParams.set("force_authentication", "1");
  res.redirect(url.toString());
});
router.get("/social/oauth/:provider/callback", async (req, res): Promise<void> => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const provider = providerOf(req.params.provider), state = typeof req.query.state === "string" ? req.query.state : "";
  if (!provider || !state || !req.isAuthenticated()) { res.redirect("/settings?oauth=failed"); return; }
  const [savedState] = await db.delete(oauthStatesTable).where(and(eq(oauthStatesTable.stateHash, hash(state)), eq(oauthStatesTable.ownerId, req.workspaceId), eq(oauthStatesTable.provider, provider))).returning();
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!savedState || savedState.expiresAt < new Date() || !code || req.query.error) { res.redirect("/settings?oauth=failed"); return; }
  try {
    const config = await publicConfig(req, provider);
    if (!config.canConnect) throw new Error("Configuration changed");
    const meta = providers[provider], body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: savedState.redirectUri });
    body.set(provider === "tiktok" ? "client_key" : "client_id", config.clientId);
    if (provider !== "x") body.set("client_secret", process.env[meta.secretName]!);
    if (provider === "youtube" || provider === "x") body.set("code_verifier", savedState.verifier);
    const data = await readJson(await fetch(meta.token, { method: "POST", headers: tokenHeaders(provider, config.clientId), body, signal: AbortSignal.timeout(30000) }));
    let token = (data.data?.access_token ? data.data : data) as Token;
    if (!token.access_token) throw new Error("No access token");
    if (provider === "instagram") {
      const url = new URL("https://graph.instagram.com/access_token");
      url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: process.env.INSTAGRAM_CLIENT_SECRET!, access_token: token.access_token }).toString();
      const long = await readJson(await fetch(url, { signal: AbortSignal.timeout(30000) }));
      token = { ...token, ...long } as Token;
      const permissions = await readJson(await fetch(`https://graph.instagram.com/v27.0/me/permissions`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) }));
      token.scope = (permissions.data ?? []).filter((p: { status: string }) => p.status === "granted").map((p: { permission: string }) => p.permission).join(",");
    }
    const granted = (token.scope ?? "").split(/[,\s]+/);
    if (!config.scopes.split(/[,\s]+/).every((s) => granted.includes(s))) throw new Error("Required scopes not granted");
    const account = await identifyAccount(provider, token);
    const mapped = await db.insert(socialAccountsTable).values({
      ownerId: req.workspaceId, provider, platform: meta.platform, remoteAccountId: account.id, handle: account.handle,
      encryptedTokens: encryptTokens(token), expiresAt: new Date(Date.now() + Math.max(0, Number(token.expires_in ?? 3600)) * 1000),
      scopes: token.scope!, approved: config.appApproved, slots: PRESETS.find((p) => p.provider === provider)!.slots,
    }).onConflictDoUpdate({ target: [socialAccountsTable.ownerId, socialAccountsTable.provider, socialAccountsTable.remoteAccountId],
      set: { encryptedTokens: encryptTokens(token), expiresAt: new Date(Date.now() + Math.max(0, Number(token.expires_in ?? 3600)) * 1000), connected: true, approved: config.appApproved, scopes: token.scope!, handle: account.handle, autoEnabled: false, error: null },
      setWhere: eq(socialAccountsTable.postingRoute, "direct"),
    }).returning();
    // A destination has one route. Updating its creator-check token is safe only while
    // the unified destination is stopped; this never creates a second posting account.
    if (!mapped.length) {
      const [existing] = await db.select().from(socialAccountsTable).where(and(eq(socialAccountsTable.ownerId, req.workspaceId), eq(socialAccountsTable.provider, provider), eq(socialAccountsTable.remoteAccountId, account.id)));
      if (provider !== "tiktok" || !existing || existing.autoEnabled) throw new Error("Destination already uses unified posting");
      await db.update(socialAccountsTable).set({ encryptedTokens: encryptTokens(token), expiresAt: new Date(Date.now() + Math.max(0, Number(token.expires_in ?? 3600)) * 1000), scopes: token.scope! })
        .where(and(eq(socialAccountsTable.id, existing.id), eq(socialAccountsTable.autoEnabled, false)));
    }
    res.redirect("/settings?oauth=connected");
  } catch {
    req.log.warn({ provider }, "Social authorization could not be completed");
    res.redirect("/settings?oauth=failed");
  }
});
export default router;
