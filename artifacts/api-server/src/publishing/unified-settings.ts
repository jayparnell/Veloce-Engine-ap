import { db, unifiedPostingSettingsTable as settings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { credentialHash, isUnifiedProvider, ownerHasUnifiedKey } from "./unifiedPublisher";
import { ProviderError } from "./providers";

export async function unifiedAuthorized(owner: string, route: string) {
  if (!isUnifiedProvider(route) || !ownerHasUnifiedKey(owner)) return false;
  const [config] = await db.select().from(settings).where(eq(settings.ownerId, owner));
  return Boolean(config && config.provider === route && config.credentialHash === credentialHash());
}
export async function requireUnifiedAuthorization(owner: string, route: string) {
  if (!await unifiedAuthorized(owner, route)) throw new ProviderError(403, "Unified posting configuration is missing or changed. Check the selected provider, key and owner binding; ZIP export remains available.");
}
export async function unifiedStatus(owner: string) {
  const [config] = await db.select().from(settings).where(eq(settings.ownerId, owner));
  const keyConfigured = Boolean(process.env.SOCIAL_POST_API_KEY);
  const ownerConfigured = process.env.SOCIAL_POST_OWNER_ID === owner;
  const ready = Boolean(keyConfigured && ownerConfigured && config && config.credentialHash === credentialHash());
  return {
    provider: config?.provider ?? "none", keyConfigured, ownerConfigured, ready, ownerBinding: owner,
    accounts: ready ? config!.discovery.map(a => ({ id: a.id, provider: a.provider, handle: a.handle })) : [],
    message: !keyConfigured ? "Export-only mode: SOCIAL_POST_API_KEY is missing. ZIP packs work normally. Mock publishing is test-only; no fake posts are created."
      : !ownerConfigured ? "For privacy, set SOCIAL_POST_OWNER_ID to your owner binding in project environment settings before discovering accounts. This is not another API key."
      : !config ? "Choose the service that issued your key. The key is sent only to that service."
      : !ready ? "The key changed. Save the selected provider again and rediscover its accounts. Existing mappings cannot publish."
      : "Ready to discover and map connected accounts. Mapping keeps automation off; enable each account explicitly below. Provider plans and approvals still apply.",
  };
}
