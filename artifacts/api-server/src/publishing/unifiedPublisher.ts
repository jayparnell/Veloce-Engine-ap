import { createHash } from "node:crypto";
import { ProviderError, retryAfter } from "./providers";
import { ReconciliationRequired, ReviewRequired, tiktokCreator, type AdapterContext, type PublishResult } from "./adapters";

export type UnifiedProvider = "ayrshare" | "late";
export type DiscoveredAccount = { id: string; nativeId: string; profileId: string; provider: string; handle: string };
// Canonical API hosts verified before implementation. app.ayrshare.com is the dashboard;
// getlate.dev now redirects to Zernio. Never forward a secret through HTTP redirects.
export const UNIFIED_BASE = { ayrshare: "https://api.ayrshare.com/api", late: "https://zernio.com/api/v1" } as const;
export const isUnifiedProvider = (value: string): value is UnifiedProvider => value === "ayrshare" || value === "late";
export const credentialHash = () => createHash("sha256").update(process.env.SOCIAL_POST_API_KEY ?? "").digest("hex");
export const ownerHasUnifiedKey = (owner: string) => Boolean(process.env.SOCIAL_POST_API_KEY && process.env.SOCIAL_POST_OWNER_ID === owner);
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
type Json = Record<string, any>;
const platformName = (provider: string) => provider === "x" ? "twitter" : provider;
const nativeName = (provider: string) => provider === "twitter" ? "x" : provider;
const supported = new Set(["youtube", "tiktok", "instagram", "x"]);

async function request(provider: UnifiedProvider, path: string, key: string, transport: typeof fetch, init: RequestInit = {}): Promise<Json> {
  if (!key) throw new ProviderError(403, "Unified posting configuration is missing. ZIP exports remain available.");
  let response: Response;
  try {
    response = await transport(`${UNIFIED_BASE[provider]}${path}`, {
      ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
  } catch {
    // No provider payload, URL, signed media token or network exception reaches logs.
    throw new Error("Unified provider connection failed. Reconcile any in-flight submission before retrying.");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Unified provider response exceeded the safe limit."); }
      chunks.push(part.value);
    }
  }
  let data: Json;
  try { data = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { throw new Error("Unified provider returned invalid JSON. Reconcile any in-flight submission."); }
  // A duplicate response with an existing receipt is reconcilable, not a fresh submission.
  if (provider === "late" && response.status === 409 && data.existingPostId) return { post: { _id: text(data.existingPostId) } };
  if (!response.ok) {
    // An error response with a receipt might already have created a post: preserve it.
    if (data.id && (Array.isArray(data.postIds) || Array.isArray(data.errors))) return data;
    const status = response.status;
    throw new ProviderError(status,
      status === 401 || status === 403 ? "Unified provider rejected authorization or profile permissions. Reconnect after checking access."
        : status === 402 ? "Unified provider plan or posting balance is unavailable. Use ZIP export or update your provider plan."
        : status === 429 ? "Unified provider rate limit reached."
        : status === 409 ? "Unified submission is already in progress. Reconcile in the provider dashboard; no repeat was sent."
        : "Unified provider rejected the request. Check account eligibility and media requirements.",
      retryAfter(response.headers.get("retry-after")));
  }
  return data;
}

export async function discoverUnified(provider: UnifiedProvider, key: string, transport: typeof fetch = fetch): Promise<DiscoveredAccount[]> {
  const data = await request(provider, provider === "ayrshare" ? "/user" : "/accounts?limit=100", key, transport);
  if (provider === "ayrshare") {
    const active = new Set(Array.isArray(data.activeSocialAccounts) ? data.activeSocialAccounts : []);
    return (Array.isArray(data.displayNames) ? data.displayNames : []).flatMap((account: Json) => {
      const native = nativeName(text(account.platform)), id = text(native === "youtube" ? account.channelId : account.id);
      if (!supported.has(native) || !id || !active.has(account.platform)) return [];
      return [{ id: `${native}:${id}`, nativeId: id, profileId: text(data.refId), provider: native, handle: text(account.handle || account.username || account.channelTitle || native).slice(0, 200) }];
    });
  }
  // Only an account's native platform identity can deduplicate it against direct OAuth.
  // Do not silently substitute the aggregator account ID for a missing native ID.
  if (data.pagination?.nextCursor) throw new ProviderError(400, "Provider returned more than 100 profiles. Use a profile-scoped key to select this workspace's accounts.");
  return (Array.isArray(data.accounts) ? data.accounts : []).flatMap((account: Json) => {
    const native = nativeName(text(account.platform)), id = text(account._id);
    const nativeId = text(account.platformUserId || account.metadata?.userId || (native === "youtube" ? account.metadata?.channelId : ""));
    if (!supported.has(native) || !id || !nativeId || account.isActive === false || account.status === "disconnected" || account.status === "expired") return [];
    return [{ id, nativeId, profileId: text(account.profileId?._id || account.profileId), provider: native, handle: text(account.username || account.displayName || native).slice(0, 200) }];
  });
}

export function safePostUrl(raw: unknown): string | null {
  try {
    const url = new URL(text(raw));
    const hosts = ["youtube.com", "youtu.be", "tiktok.com", "instagram.com", "x.com", "twitter.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null;
    const videoId = url.hostname.endsWith("youtube.com") && url.pathname === "/watch" ? url.searchParams.get("v") : null;
    url.search = ""; url.hash = "";
    if (videoId && /^[a-zA-Z0-9_-]{1,128}$/.test(videoId)) url.searchParams.set("v", videoId);
    return url.toString();
  } catch { return null; }
}
type Receipt = { id: string; initial: { status: "published" | "processing" | "failed"; remoteId?: string; remoteUrl?: string; error?: string } };
export function interpretUnified(provider: UnifiedProvider, data: Json, native: string, accountId: string): Receipt {
  const platform = platformName(native);
  const post = provider === "late" ? data.post ?? {} : data;
  const id = text(provider === "late" ? post._id || data.postId : data.id);
  const targets: Json[] = provider === "late" ? post.platforms ?? [] : data.postIds ?? [];
  const entry = targets.find(p => p.platform === platform && (provider !== "late" || text(p.accountId?._id || p.accountId) === accountId));
  const errors: Json[] = Array.isArray(data.errors) ? data.errors : [];
  const failed = entry?.status === "failed" || entry?.status === "error" || entry?.status === "cancelled" || errors.some(e => e.platform === platform);
  if (failed) return { id, initial: { status: "failed", error: "This destination rejected publishing. Check its permissions, plan, consent and media in the provider dashboard. Other destinations are independent." } };
  const nativeId = text(provider === "late" ? entry?.platformPostId : entry?.id);
  const confirmed = provider === "late" ? entry?.status === "published" : entry?.status === "success";
  if (confirmed && nativeId && !["pending", "processing", "undefined", "null"].includes(nativeId.toLowerCase())) {
    return { id, initial: { status: "published", remoteId: nativeId, remoteUrl: safePostUrl(provider === "late" ? entry?.platformPostUrl : entry?.postUrl) ?? undefined } };
  }
  if (post.status === "failed" || post.status === "cancelled" || (provider === "ayrshare" && data.status === "error")) {
    return { id, initial: { status: "failed", error: "Provider reports that this post failed. Review the provider dashboard; nothing was marked published." } };
  }
  return { id, initial: { status: "processing" } };
}

export async function unifiedPublisher(ctx: AdapterContext, provider: UnifiedProvider, slotId: number, key = process.env.SOCIAL_POST_API_KEY ?? ""): Promise<PublishResult & { remoteUrl?: string }> {
  if (!key) throw new ProviderError(403, "Unified posting configuration is missing. Download Ready-to-Post Pack (.zip) remains available.");
  const target = ctx.account.unifiedAccountId;
  if (!target) throw new ProviderError(403, "Unified account mapping is missing. Reconnect this destination.");
  const caption = `${ctx.clip.title}\n${ctx.clip.hashtags}`.slice(0, 2000);
  const approval = ctx.checkpoint.approval as Json | undefined;
  const saved = ctx.checkpoint.unifiedReceipt as Receipt | undefined;
  // A saved accepted submission is only polled. Consent is required before creating it,
  // not before confirming the already accepted post.
  if (!saved && ctx.account.provider === "tiktok" &&
    (!approval?.consent || !approval.disclosureReviewed || approval.clipId !== ctx.clip.id || approval.objectPath !== ctx.clip.objectPath || approval.caption !== caption)) {
    throw new ReviewRequired("TikTok requires review of this video, an explicit privacy choice, Music Usage confirmation, and commercial disclosures. Connect direct TikTok authorization for creator restrictions or export manually.");
  }
  if (!saved && ctx.account.provider === "tiktok") {
    if (!ctx.token) throw new ReviewRequired("Connect direct TikTok authorization to verify creator privacy restrictions before unified posting, or use ZIP export. No privacy choice is inferred.");
    const creator = await tiktokCreator(ctx);
    if (!creator.privacy_level_options?.includes(approval!.privacyLevel) || ctx.clip.duration > creator.max_video_post_duration_sec)
      throw new ReviewRequired("TikTok creator privacy or duration restrictions changed. Review this video again.");
    if (approval!.brandContent && approval!.privacyLevel !== "PUBLIC_TO_EVERYONE") throw new ReviewRequired("TikTok branded content requires public privacy.");
    approval!.disableComment ||= creator.comment_disabled;
    approval!.disableDuet ||= creator.duet_disabled;
    approval!.disableStitch ||= creator.stitch_disabled;
  }
  let receipt = saved;
  if (!receipt) {
    receipt = await ctx.effect<Receipt>("unified-submit", async () => {
      const mediaUrl = await ctx.mediaUrl();
      const idempotencyKey = `veloce:${ctx.clip.id}:${slotId}`;
      const native = ctx.account.provider;
      const options: Json = native === "youtube" ? { title: `${ctx.clip.title.slice(0, 90)} #Shorts`, privacyStatus: "public", madeForKids: false, containsSyntheticMedia: true }
        : native === "instagram" ? { contentType: "reel" } : {};
      if (native === "tiktok") {
        if (approval!.brandContent && approval!.privacyLevel !== "PUBLIC_TO_EVERYONE") throw new ReviewRequired("TikTok branded content requires public privacy.");
        options.tiktokSettings = {
          privacy_level: approval!.privacyLevel, disable_comment: approval!.disableComment,
          disable_duet: approval!.disableDuet, disable_stitch: approval!.disableStitch,
          brand_content_toggle: approval!.brandContent, brand_organic_toggle: approval!.brandOrganic, is_aigc: true,
        };
      }
      const body = provider === "late" ? {
        content: caption, publishNow: true, mediaItems: [{ type: "video", url: mediaUrl }],
        platforms: [{ platform: platformName(native), accountId: target, platformSpecificData: options }],
      } : {
        post: caption, platforms: [platformName(native)], mediaUrls: [mediaUrl], isVideo: true, idempotencyKey,
        ...(native === "youtube" ? { youTubeOptions: { title: `${ctx.clip.title.slice(0, 90)} #Shorts`, visibility: "public", madeForKids: false } } : {}),
        ...(native === "instagram" ? { instagramOptions: { reels: true } } : {}),
        ...(native === "tiktok" ? { tikTokOptions: {
          privacyLevel: approval!.privacyLevel, disableComments: approval!.disableComment, disableDuet: approval!.disableDuet,
          disableStitch: approval!.disableStitch, brandContent: approval!.brandContent, brandOrganic: approval!.brandOrganic, isAIGenerated: true,
        } } : {}),
      };
      const data = await request(provider, provider === "ayrshare" ? "/post" : "/posts", key, ctx.request, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body),
      });
      const parsed = interpretUnified(provider, data, native, target);
      if (!parsed.id && parsed.initial.status === "processing") throw new ReconciliationRequired("Provider accepted the request without a receipt. Reconcile in its dashboard; no repeat will be sent.");
      return parsed;
    });
    await ctx.save("unifiedReceipt", receipt);
    return receipt.initial;
  }
  if (receipt.initial.status !== "processing") return receipt.initial;
  if (!receipt.id) throw new ReconciliationRequired("Saved provider receipt is missing. No repeat was sent.");
  const data = await request(provider, provider === "late" ? `/posts/${encodeURIComponent(receipt.id)}` : `/history/${encodeURIComponent(receipt.id)}`, key, ctx.request);
  return interpretUnified(provider, data, ctx.account.provider, target).initial;
}
