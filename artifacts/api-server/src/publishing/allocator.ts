import { db, socialAccountsTable as accounts, publishQueueTable as queue, generatedClipsTable as clips, socialConfigsTable } from "@workspace/db";
import { and, eq, sql, gte } from "drizzle-orm";
import { nextSlot } from "./slots";
import { isUnifiedProvider } from "./unifiedPublisher";
import { unifiedAuthorized } from "./unified-settings";

export async function assignReadyClips(ownerId?: string, accountId?: number) {
  const candidates = await db.select().from(accounts).where(and(eq(accounts.connected, true), eq(accounts.approved, true), eq(accounts.autoEnabled, true), ownerId ? eq(accounts.ownerId, ownerId) : undefined, accountId ? eq(accounts.id, accountId) : undefined));
  for (const a of candidates) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(74001,${a.id})`);
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, a.id)).for("update");
      const [config] = await tx.select().from(socialConfigsTable).where(and(eq(socialConfigsTable.ownerId, a.ownerId), eq(socialConfigsTable.provider, a.provider)));
      if (!account?.autoEnabled || !account.connected || !account.approved) return;
      if (isUnifiedProvider(account.postingRoute)) {
        if (!await unifiedAuthorized(account.ownerId, account.postingRoute)) return;
      } else if (account.postingRoute !== "direct" || !config?.appApproved || !account.encryptedTokens) return;
      // Enabling automation must not unexpectedly publish someone's historical vault.
      if (!account.autoEnabledAt) return;
      const ready = await tx.select().from(clips).where(and(eq(clips.ownerId, a.ownerId), eq(clips.status, "ready"), eq(clips.demo, false), gte(clips.createdAt, account.autoEnabledAt)));
      const reserved = await tx.select().from(queue).where(eq(queue.accountId, a.id));
      const occupied = new Set(reserved.map((s) => s.scheduledAt.toISOString()));
      const assigned = new Set(reserved.map((s) => s.clipId));
      for (const clip of ready.sort((x, y) => x.id - y.id)) {
        if (assigned.has(clip.id) || !clip.objectPath || (!account.includeDubs && clip.language !== "en")) continue;
        const scheduledAt = nextSlot(new Date(), account.timezone, account.slots, occupied);
        await tx.insert(queue).values({ ownerId: a.ownerId, accountId: a.id, clipId: clip.id, scheduledAt, timezone: account.timezone }).onConflictDoNothing();
        occupied.add(scheduledAt.toISOString()); assigned.add(clip.id);
      }
    });
  }
}
