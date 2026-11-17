import { Router, type IRouter } from "express";
import { db, socialAccountsTable as accounts, publishQueueTable as queue, unifiedPostingSettingsTable as settings } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { GetUnifiedPostingResponse, SaveUnifiedPostingBody, ConnectUnifiedAccountBody } from "@workspace/api-zod";
import { credentialHash, discoverUnified, isUnifiedProvider, ownerHasUnifiedKey } from "../publishing/unifiedPublisher";
import { requireUnifiedAuthorization, unifiedStatus } from "../publishing/unified-settings";
import { ProviderError } from "../publishing/providers";
import { PRESETS } from "../publishing/slots";

export function createUnifiedPostingRouter(transport: typeof fetch = fetch): IRouter {
const router: IRouter = Router();
router.use("/autopilot/unified", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Sign in to manage private posting accounts." }); return; }
  next();
});
router.get("/autopilot/unified", async (req, res) => {
  res.json(GetUnifiedPostingResponse.parse(await unifiedStatus(req.workspaceId)));
});
router.put("/autopilot/unified", async (req, res): Promise<void> => {
  const input = SaveUnifiedPostingBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Select Ayrshare or Late explicitly." }); return; }
  // A project-wide key must never expose all of its profiles to arbitrary app signups.
  if (process.env.SOCIAL_POST_API_KEY && !ownerHasUnifiedKey(req.workspaceId)) {
    res.status(403).json({ error: "Set SOCIAL_POST_OWNER_ID to this workspace's owner binding before configuring the shared posting key." }); return;
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74004,0)`);
    const [old] = await tx.select().from(settings).where(eq(settings.ownerId, req.workspaceId));
    if (old?.provider === input.data.provider && old.credentialHash === credentialHash()) return;
    // Preserve all old receipts for reconciliation; provider/key changes never replay them.
    await tx.update(accounts).set({ autoEnabled: false, approved: false, connected: false, error: "Unified provider configuration changed. Rediscover and reconnect this account." })
      .where(and(eq(accounts.ownerId, req.workspaceId), ne(accounts.postingRoute, "direct")));
    await tx.insert(settings).values({ ownerId: req.workspaceId, provider: input.data.provider, credentialHash: credentialHash() })
      .onConflictDoUpdate({ target: settings.ownerId, set: { provider: input.data.provider, credentialHash: credentialHash(), discovery: [], discoveredAt: null } });
  });
  res.json(GetUnifiedPostingResponse.parse(await unifiedStatus(req.workspaceId)));
});
router.post("/autopilot/unified/discover", async (req, res): Promise<void> => {
  const [config] = await db.select().from(settings).where(eq(settings.ownerId, req.workspaceId));
  if (!config || !isUnifiedProvider(config.provider)) { res.status(409).json({ error: "Select and save a provider first. ZIP exports remain available." }); return; }
  try {
    await requireUnifiedAuthorization(req.workspaceId, config.provider);
    const discovery = await discoverUnified(config.provider, process.env.SOCIAL_POST_API_KEY!, transport);
    await db.update(settings).set({ discovery, discoveredAt: new Date() }).where(and(eq(settings.ownerId, req.workspaceId), eq(settings.provider, config.provider), eq(settings.credentialHash, config.credentialHash)));
    res.json(GetUnifiedPostingResponse.parse(await unifiedStatus(req.workspaceId)));
  } catch (error) {
    res.status(error instanceof ProviderError ? error.status : 502).json({ error: error instanceof ProviderError ? error.message : "Profile discovery failed. No accounts were connected and no posts were sent." });
  }
});
router.post("/autopilot/unified/accounts", async (req, res): Promise<void> => {
  const input = ConnectUnifiedAccountBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Choose a discovered account." }); return; }
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(74004,0)`);
      const [config] = await tx.select().from(settings).where(eq(settings.ownerId, req.workspaceId)).for("update");
      if (!config || !ownerHasUnifiedKey(req.workspaceId) || config.credentialHash !== credentialHash()) return "Provider configuration is missing or changed.";
      const found = config.discovery.find(a => a.id === input.data.id);
      if (!found || !config.discoveredAt || Date.now() - config.discoveredAt.getTime() > 900000) return "Rediscover your connected accounts before mapping a destination.";
      const [old] = await tx.select().from(accounts).where(and(eq(accounts.ownerId, req.workspaceId), eq(accounts.provider, found.provider), eq(accounts.remoteAccountId, found.nativeId))).for("update");
      if (old) {
        // Route or credential changes cannot reinterpret prior work or abandon uncertain writes.
        const pending = await tx.select({ id: queue.id }).from(queue).where(and(eq(queue.accountId, old.id), sql`${queue.status} NOT IN ('published','failed')`)).limit(1);
        if (pending.length || old.autoEnabled) return "Turn off automation and resolve existing queued or uncertain posts before reconnecting this destination. Exports remain available.";
        await tx.update(accounts).set({ postingRoute: config.provider, unifiedAccountId: found.id, unifiedProfileId: found.profileId, handle: found.handle, connected: true, approved: true, autoEnabled: false, error: null })
          .where(eq(accounts.id, old.id));
      } else {
        await tx.insert(accounts).values({ ownerId: req.workspaceId, provider: found.provider, platform: PRESETS.find(p => p.provider === found.provider)!.platform,
          remoteAccountId: found.nativeId, handle: found.handle, postingRoute: config.provider, unifiedAccountId: found.id, unifiedProfileId: found.profileId,
          scopes: "", connected: true, approved: true, autoEnabled: false, slots: PRESETS.find(p => p.provider === found.provider)!.slots });
      }
      return null;
    });
    if (result) { res.status(409).json({ error: result }); return; }
    res.json({ message: "Connected. Automatic posting remains OFF. Review the account's slots before explicitly enabling it. TikTok additionally requires verified creator restrictions and per-video consent." });
  } catch {
    res.status(409).json({ error: "This destination changed while connecting. Refresh your accounts; no post was sent." });
  }
});
return router;
}
export default createUnifiedPostingRouter();
