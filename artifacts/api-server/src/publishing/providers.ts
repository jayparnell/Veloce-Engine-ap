import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
export const PROVIDERS = {
  youtube: { name: "YouTube Data API v3", platform: "YouTube Shorts", authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", secretName: "GOOGLE_CLIENT_SECRET", apiKeyName: "YOUTUBE_API_KEY", scopes: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly" },
  tiktok: { name: "TikTok Content Posting API", platform: "TikTok", authorize: "https://www.tiktok.com/v2/auth/authorize/", token: "https://open.tiktokapis.com/v2/oauth/token/", secretName: "TIKTOK_CLIENT_SECRET", apiKeyName: "", scopes: "user.info.basic,video.publish,video.upload" },
  instagram: { name: "Instagram Professional API", platform: "Instagram Reels", authorize: "https://www.instagram.com/oauth/authorize", token: "https://api.instagram.com/oauth/access_token", secretName: "INSTAGRAM_CLIENT_SECRET", apiKeyName: "", scopes: "instagram_business_basic,instagram_business_content_publish" },
  x: { name: "X API v2", platform: "X", authorize: "https://x.com/i/oauth2/authorize", token: "https://api.x.com/2/oauth2/token", secretName: "X_CLIENT_SECRET", apiKeyName: "", scopes: "tweet.read tweet.write users.read media.write offline.access" },
} as const;
export type Provider = keyof typeof PROVIDERS;
export function providerOf(value: unknown): Provider | null { return typeof value === "string" && Object.hasOwn(PROVIDERS, value) ? value as Provider : null; }
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function key() {
  if (!process.env.SESSION_SECRET) throw new Error("Session encryption is not configured");
  return createHash("sha256").update(`veloce-social:${process.env.SESSION_SECRET}`).digest();
}
export function encryptTokens(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((p) => p.toString("base64url")).join(".");
}
export function decryptTokens<T>(value: string): T {
  const [iv, tag, bytes] = value.split(".").map((s) => Buffer.from(s, "base64url"));
  if (!iv || !tag || !bytes) throw new Error("Stored authorization is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString()) as T;
}
export type Token = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; user_id?: string; open_id?: string; [key: string]: unknown };
export function tokenHeaders(provider: Provider, clientId: string) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (provider === "x") headers.Authorization = `Basic ${Buffer.from(`${clientId}:${process.env.X_CLIENT_SECRET ?? ""}`).toString("base64")}`;
  return headers;
}
export async function readJson(response: Response) {
  const text = await response.text();
  let data: Record<string, any>;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new ProviderError(response.status, "Provider returned an invalid response. Reconcile any in-flight publishing attempt."); }
  const code = String(data.error?.code ?? "");
  const status = /rate_limit|quota/i.test(code) ? 429 : /access_token|scope|auth/i.test(code) ? 403 : response.ok && (data.error && code !== "ok" || data.errors) ? 400 : response.status;
  if (!response.ok || data.error && code !== "ok" || data.errors) throw new ProviderError(status, status === 429 ? "Provider quota or rate limit reached." : status === 401 || status === 403 ? "Provider rejected authorization or posting permissions. Reconnect or obtain approval." : "Provider rejected the request. Check format, account eligibility and application approval.");
  return data;
}
export class ProviderError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function identifyAccount(provider: Provider, token: Token) {
  const authorization = { Authorization: `Bearer ${token.access_token}` };
  if (provider === "youtube") {
    const data = await readJson(await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers: authorization, signal: AbortSignal.timeout(30000) }));
    const channel = data.items?.[0]; if (!channel?.id) throw new Error("No authorized YouTube channel");
    return { id: String(channel.id), handle: String(channel.snippet?.title ?? channel.id) };
  }
  if (provider === "tiktok") {
    const data = await readJson(await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: authorization, signal: AbortSignal.timeout(30000) }));
    const user = data.data?.user; if (!user?.open_id) throw new Error("No authorized TikTok account");
    return { id: String(user.open_id), handle: String(user.display_name ?? user.open_id) };
  }
  if (provider === "instagram") {
    const data = await readJson(await fetch("https://graph.instagram.com/v27.0/me?fields=user_id,username", { headers: authorization, signal: AbortSignal.timeout(30000) }));
    if (!data.user_id && !data.id) throw new Error("No professional Instagram account");
    return { id: String(data.user_id ?? data.id), handle: String(data.username ?? data.user_id) };
  }
  const data = await readJson(await fetch("https://api.x.com/2/users/me", { headers: authorization, signal: AbortSignal.timeout(30000) }));
  if (!data.data?.id) throw new Error("No authorized X account");
  return { id: String(data.data.id), handle: `@${data.data.username}` };
}
