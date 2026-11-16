import { db, socialAccountsTable as accounts, socialConfigsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { PROVIDERS, providerOf, decryptTokens, encryptTokens, readJson, tokenHeaders, type Token } from "./providers";

export async function accountToken(id: number): Promise<Token> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74003,${id})`);
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
    if (!account?.connected || !account.encryptedTokens) throw new Error("Reconnect this account before publishing.");
    const provider = providerOf(account.provider);
    if (!provider) throw new Error("Provider is unsupported.");
    const token = decryptTokens<Token>(account.encryptedTokens);
    if (account.expiresAt && account.expiresAt.getTime() > Date.now() + 300000) return token;
    const [config] = await tx.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, account.ownerId), eq(socialConfigsTable.provider, provider)));
    if (!config?.clientId) throw new Error("Application configuration is missing.");
    let refreshed: Token;
    if (provider === "instagram") {
      const url = new URL("https://graph.instagram.com/refresh_access_token");
      url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token.access_token }).toString();
      refreshed = { ...token, ...await readJson(await fetch(url, { signal: AbortSignal.timeout(30000) })) } as Token;
    } else {
      if (!token.refresh_token) throw new Error("Authorization expired without refresh permission. Reconnect this account.");
      const meta = PROVIDERS[provider], body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token });
      body.set(provider === "tiktok" ? "client_key" : "client_id", config.clientId);
      if (provider !== "x") body.set("client_secret", process.env[meta.secretName] ?? "");
      refreshed = { ...token, ...await readJson(await fetch(meta.token, { method: "POST", headers: tokenHeaders(provider, config.clientId), body, signal: AbortSignal.timeout(30000) })) } as Token;
    }
    if (!refreshed.access_token) throw new Error("Provider did not confirm refreshed authorization. Reconnect.");
    await tx.update(accounts).set({ encryptedTokens: encryptTokens(refreshed), expiresAt: new Date(Date.now() + Number(refreshed.expires_in ?? 3600) * 1000), error: null }).where(eq(accounts.id, id));
    return refreshed;
  }).catch(async () => {
    // A refresh response may rotate credentials before a network/DB failure. Do not blindly repeat it.
    await db.update(accounts).set({ autoEnabled: false, error: "Authorization refresh failed or its outcome is uncertain. Reconnect before enabling publishing again." }).where(eq(accounts.id, id));
    throw new Error("Authorization refresh failed or is uncertain. Reconnect this account.");
  });
}
