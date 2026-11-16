import { type Clip, type SocialAccount, type Checkpoint } from "@workspace/db";
import { ProviderError, readJson, encryptTokens, decryptTokens } from "./providers";

export class ReconciliationRequired extends Error {}
export class ReviewRequired extends Error {}
export type PublishResult = { status: "published" | "processing" | "failed"; remoteId?: string; error?: string };
export type AdapterContext = {
  account: SocialAccount; clip: Clip; token: string; checkpoint: Checkpoint;
  save: (key: string, value: unknown) => Promise<void>;
  effect: <T>(key: string, call: () => Promise<T>) => Promise<T>;
  request: typeof fetch;
  bytes: () => Promise<Buffer>;
  mediaUrl: () => Promise<string>;
};
const bearer = (ctx: AdapterContext) => ({ Authorization: `Bearer ${ctx.token}` });
const jsonHeaders = (ctx: AdapterContext) => ({ ...bearer(ctx), "Content-Type": "application/json" });
const requestJson = async (ctx: AdapterContext, url: string, init: RequestInit = {}) => readJson(await ctx.request(url, { ...init, signal: AbortSignal.timeout(60000), redirect: "error" }));
const copy = (ctx: AdapterContext) => `${ctx.clip.title}\n${ctx.clip.hashtags}`.slice(0, 2000);
function providerUploadUrl(raw: string, provider: "youtube" | "tiktok") {
  const url = new URL(raw);
  const hosts = provider === "youtube" ? ["googleapis.com", "youtube.com"] : ["tiktokapis.com", "tiktok.com", "tiktokcdn.com", "byteoversea.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) throw new Error("Provider returned an unsupported upload endpoint.");
  return url.toString();
}
async function youtube(ctx: AdapterContext): Promise<PublishResult> {
  const bytes = await ctx.bytes();
  let session = ctx.checkpoint.youtubeSession as string | undefined;
  if (!session) {
    const encrypted = await ctx.effect("youtube-session", async () => {
      const response = await ctx.request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST", headers: { ...jsonHeaders(ctx), "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.length) },
        body: JSON.stringify({ snippet: { title: `${ctx.clip.title.slice(0, 90)} #Shorts`, description: copy(ctx), categoryId: "22", defaultLanguage: ctx.clip.language },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true } }),
        signal: AbortSignal.timeout(60000), redirect: "error",
      });
      if (!response.ok) await readJson(response);
      const location = response.headers.get("location");
      if (!location) throw new Error("No resumable upload session");
      return encryptTokens(providerUploadUrl(location, "youtube"));
    });
    session = String(encrypted); await ctx.save("youtubeSession", session);
  }
  const url = providerUploadUrl(decryptTokens<string>(session), "youtube");
  let start = 0;
  // Query status before every write, including the first, to reconcile lost final responses.
  const status = await ctx.request(url, { method: "PUT", headers: { ...bearer(ctx), "Content-Length": "0", "Content-Range": `bytes */${bytes.length}` }, signal: AbortSignal.timeout(60000), redirect: "error" });
  if (status.ok) {
    const result = await readJson(status);
    if (result.id) return { status: "published", remoteId: String(result.id) };
    throw new ReconciliationRequired("Upload completed without a confirmed remote video identifier.");
  }
  if (status.status !== 308) {
    if (status.status === 404 || status.status === 410) throw new ReconciliationRequired("YouTube upload session expired; check the channel before starting another post.");
    await readJson(status);
  }
  const range = status.headers.get("range")?.match(/bytes=0-(\d+)/);
  if (range) start = Number(range[1]) + 1;
  if (start >= bytes.length) return { status: "processing" };
  const response = await ctx.request(url, { method: "PUT", headers: { ...bearer(ctx), "Content-Type": "video/mp4", "Content-Length": String(bytes.length - start), "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
    body: new Uint8Array(bytes.subarray(start)), signal: AbortSignal.timeout(180000), redirect: "error" });
  if (response.status === 308) return { status: "processing" };
  const result = await readJson(response);
  if (!result.id) throw new ReconciliationRequired("YouTube has not confirmed a remote video identifier.");
  return { status: "published", remoteId: String(result.id) };
}
export async function tiktokCreator(ctx: Pick<AdapterContext, "request" | "token">) {
  const data = await readJson(await ctx.request("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) }));
  return data.data as { creator_nickname?: string; privacy_level_options: string[]; comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean; max_video_post_duration_sec: number };
}
async function tiktok(ctx: AdapterContext): Promise<PublishResult> {
  const approval = ctx.checkpoint.approval as { privacyLevel: string; disableComment: boolean; disableDuet: boolean; disableStitch: boolean; consent: boolean; disclosureReviewed: boolean; brandContent: boolean; brandOrganic: boolean; clipId: number; objectPath: string; caption: string } | undefined;
  let publishId = ctx.checkpoint.tiktokPublishId as string | undefined;
  if (!publishId) {
    if (!approval?.consent || !approval.disclosureReviewed || approval.clipId !== ctx.clip.id || approval.objectPath !== ctx.clip.objectPath || approval.caption !== copy(ctx)) throw new ReviewRequired("TikTok requires review of this specific video, commercial disclosures, Music Usage Confirmation, and an explicit privacy choice.");
    if (approval.brandContent && approval.privacyLevel !== "PUBLIC_TO_EVERYONE") throw new ReviewRequired("Branded partner content requires an explicitly selected public post.");
    const creator = await tiktokCreator(ctx);
    if (!creator.privacy_level_options?.includes(approval.privacyLevel) || ctx.clip.duration > creator.max_video_post_duration_sec) throw new ReviewRequired("TikTok creator restrictions changed. Review this clip again.");
    const bytes = await ctx.bytes();
    // A single chunk is permitted below 64MB. Larger clips remain exportable instead of guessing a chunk protocol.
    if (bytes.length > 64 * 1024 ** 2) throw new ProviderError(400, "TikTok upload exceeds the supported 64 MB single-chunk bound. Export and upload manually.");
    const init = await ctx.effect("tiktok-init", () => requestJson(ctx, "https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({
        post_info: { title: copy(ctx), privacy_level: approval.privacyLevel,
          disable_comment: creator.comment_disabled || approval.disableComment, disable_duet: creator.duet_disabled || approval.disableDuet,
          disable_stitch: creator.stitch_disabled || approval.disableStitch, is_aigc: true,
          brand_content_toggle: approval.brandContent, brand_organic_toggle: approval.brandOrganic },
        source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: bytes.length, total_chunk_count: 1 },
      }),
    }));
    if (!init.data?.publish_id || !init.data.upload_url) throw new ReconciliationRequired("TikTok did not confirm an upload identifier.");
    publishId = String(init.data.publish_id);
    await ctx.save("tiktokPublishId", publishId);
    await ctx.save("tiktokUploadUrl", encryptTokens(providerUploadUrl(init.data.upload_url, "tiktok")));
  }
  const status = await requestJson(ctx, "https://open.tiktokapis.com/v2/post/publish/status/fetch/", { method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({ publish_id: publishId }) });
  const data = status.data ?? {};
  if (data.status === "PUBLISH_COMPLETE") {
    const ids = data.publicaly_available_post_id ?? data.publicly_available_post_id;
    if (Array.isArray(ids) && ids[0]) return { status: "published", remoteId: String(ids[0]) };
    throw new ReconciliationRequired("TikTok completed processing but did not expose a confirmed post ID (for example, private visibility). Reconcile in the provider dashboard; no duplicate will be sent.");
  }
  if (data.status === "FAILED") return { status: "failed", error: "TikTok rejected this post. Review account restrictions, media and creator policies." };
  if (data.status === "PROCESSING_UPLOAD" && !ctx.checkpoint.tiktokUploaded) {
    if ((ctx.checkpoint["effect:tiktok-upload"] as { state?: string } | undefined)?.state === "started") throw new ReconciliationRequired("TikTok upload outcome is uncertain. Reconcile the saved publish ID before uploading again.");
    const bytes = await ctx.bytes();
    const url = providerUploadUrl(decryptTokens<string>(String(ctx.checkpoint.tiktokUploadUrl)), "tiktok");
    await ctx.effect("tiktok-upload", async () => {
      const response = await ctx.request(url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length), "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
        body: new Uint8Array(bytes), signal: AbortSignal.timeout(180000), redirect: "error" });
      if (!response.ok) await readJson(response);
      return true;
    });
    await ctx.save("tiktokUploaded", true);
  }
  return { status: "processing" };
}
async function instagram(ctx: AdapterContext): Promise<PublishResult> {
  const base = "https://graph.instagram.com/v27.0", account = encodeURIComponent(ctx.account.remoteAccountId);
  let containerId = ctx.checkpoint.instagramContainer as string | undefined;
  if (!containerId) {
    const quota = await requestJson(ctx, `${base}/${account}/content_publishing_limit?fields=quota_usage,config`, { headers: bearer(ctx) });
    const limit = quota.data?.[0];
    if (limit && Number(limit.quota_usage) >= Number(limit.config?.quota_total ?? 100)) throw new ProviderError(429, "Instagram daily publishing quota reached.");
    const mediaUrl = await ctx.mediaUrl();
    const result = await ctx.effect("instagram-container", () => requestJson(ctx, `${base}/${account}/media`, { method: "POST", headers: jsonHeaders(ctx),
      body: JSON.stringify({ media_type: "REELS", video_url: mediaUrl, caption: copy(ctx), is_ai_generated: true, share_to_feed: true }) }));
    if (!result.id) throw new ReconciliationRequired("Instagram did not confirm a media container.");
    containerId = String(result.id); await ctx.save("instagramContainer", containerId);
  }
  const status = await requestJson(ctx, `${base}/${encodeURIComponent(containerId)}?fields=status_code`, { headers: bearer(ctx) });
  if (status.status_code === "ERROR" || status.status_code === "EXPIRED") return { status: "failed", error: "Instagram container failed or expired. Review it before retrying." };
  if (status.status_code === "PUBLISHED") {
    const result = ctx.checkpoint["effect:instagram-publish"] as { state?: string; result?: { id?: string } } | undefined;
    if (result?.state === "done" && result.result?.id) return { status: "published", remoteId: result.result.id };
    throw new ReconciliationRequired("Instagram reports this container published but the media ID was not saved. Reconcile in the account; no repeat publish will be made.");
  }
  if (status.status_code !== "FINISHED") return { status: "processing" };
  const result = await ctx.effect("instagram-publish", () => requestJson(ctx, `${base}/${account}/media_publish`, { method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({ creation_id: containerId }) }));
  if (!result.id) throw new ReconciliationRequired("Instagram did not confirm a published media ID.");
  return { status: "published", remoteId: String(result.id) };
}
async function x(ctx: AdapterContext): Promise<PublishResult> {
  const base = "https://api.x.com/2";
  let mediaId = ctx.checkpoint.xMediaId as string | undefined;
  if (!mediaId) {
    const bytes = await ctx.bytes();
    const init = await ctx.effect("x-init", () => requestJson(ctx, `${base}/media/upload/initialize`, { method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({ media_category: "tweet_video", media_type: "video/mp4", total_bytes: bytes.length }) }));
    if (!init.data?.id) throw new ReconciliationRequired("X did not return a media identifier.");
    mediaId = String(init.data.id); await ctx.save("xMediaId", mediaId);
    if (init.data.media_key) await ctx.save("xMediaKey", init.data.media_key);
  }
  const media = encodeURIComponent(mediaId);
  if (!ctx.checkpoint.xFinalized) {
    const bytes = await ctx.bytes();
    for (let offset = 0, index = 0; offset < bytes.length; offset += 4 * 1024 ** 2, index++) {
      await ctx.effect(`x-append:${index}`, () => requestJson(ctx, `${base}/media/upload/${media}/append`, { method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({ segment_index: index, media: bytes.subarray(offset, offset + 4 * 1024 ** 2).toString("base64") }) }));
    }
    await ctx.effect("x-finalize", () => requestJson(ctx, `${base}/media/upload/${media}/finalize`, { method: "POST", headers: jsonHeaders(ctx), body: "{}" }));
    await ctx.save("xFinalized", true);
  }
  const status = await requestJson(ctx, `${base}/media/upload?media_id=${media}`, { headers: bearer(ctx) });
  if (status.data?.processing_info?.state === "failed") return { status: "failed", error: "X rejected video processing. Check media and account limits." };
  if (["pending", "in_progress"].includes(status.data?.processing_info?.state)) return { status: "processing" };
  const result = await ctx.effect("x-post", () => requestJson(ctx, `${base}/tweets`, { method: "POST", headers: jsonHeaders(ctx), body: JSON.stringify({ text: copy(ctx).slice(0, 280), media: { media_ids: [mediaId] } }) }));
  if (!result.data?.id) throw new ReconciliationRequired("X did not confirm a post ID. Review recent posts before retrying.");
  return { status: "published", remoteId: String(result.data.id) };
}
export async function publishAdapter(ctx: AdapterContext): Promise<PublishResult> {
  switch (ctx.account.provider) {
    case "youtube": return youtube(ctx);
    case "tiktok": return tiktok(ctx);
    case "instagram": return instagram(ctx);
    case "x": return x(ctx);
    default: throw new ProviderError(400, "Provider is not supported.");
  }
}
