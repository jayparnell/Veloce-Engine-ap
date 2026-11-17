import { XMLParser, XMLValidator } from "fast-xml-parser";

export class FeedInputError extends Error {}
export class FeedFetchError extends Error {}
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const PLAYLIST_ID = /^(?:PL[A-Za-z0-9_-]{10,78}|UU[A-Za-z0-9_-]{22})$/;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
export type FeedIdentity = { kind: "channel" | "playlist"; providerId: string; feedUrl: string };
export type FeedEntry = { videoId: string; title: string };
export type FeedResult = { unchanged: boolean; entries: FeedEntry[]; title?: string; etag: string | null; lastModified: string | null };
export function feedIdentity(kind: FeedIdentity["kind"], id: string): FeedIdentity {
  if (!(kind === "channel" ? CHANNEL_ID : PLAYLIST_ID).test(id)) throw new FeedInputError("Unsupported YouTube channel or playlist ID.");
  return { kind, providerId: id, feedUrl: `https://www.youtube.com/feeds/videos.xml?${kind === "channel" ? "channel_id" : "playlist_id"}=${id}` };
}
/** Canonical video identity only; never use feed-provided links as fetch targets. */
export function youtubeVideoId(source: string): string | null {
  try {
    const u = new URL(source);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const id = u.hostname === "youtu.be" ? u.pathname.slice(1)
      : hosts.has(u.hostname) ? u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(u.pathname)?.[1] : null;
    return id && VIDEO_ID.test(id) ? id : null;
  } catch { return null; }
}
export function parseFeedInput(source: string): FeedIdentity | { channelPage: string } {
  const input = source.trim();
  if (CHANNEL_ID.test(input)) return feedIdentity("channel", input);
  if (PLAYLIST_ID.test(input)) return feedIdentity("playlist", input);
  let u: URL;
  try { u = new URL(input.startsWith("@") ? `https://www.youtube.com/${input}` : input); }
  catch { throw new FeedInputError("Use a UC channel ID, PL/UU playlist ID, or a standard HTTPS YouTube channel or playlist URL."); }
  if (u.protocol !== "https:" || !hosts.has(u.hostname) || u.username || u.password || u.port || u.hash) throw new FeedInputError("Only standard HTTPS YouTube channel and playlist URLs are supported.");
  const path = u.pathname.replace(/\/$/, "");
  if (path === "/playlist" && [...u.searchParams.keys()].every((k) => k === "list") && u.searchParams.getAll("list").length === 1) return feedIdentity("playlist", u.searchParams.get("list")!);
  // Tabs do not change channel identity. Query strings and arbitrary paths are not fetched.
  if (u.search) throw new FeedInputError("Remove query parameters from the channel URL.");
  const direct = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/(?:videos|shorts|streams|featured))?$/.exec(path);
  if (direct) return feedIdentity("channel", direct[1]!);
  const page = /^(\/(?:@[^/]+|(?:c|user)\/[^/]+))(?:\/(?:videos|shorts|streams|featured))?$/.exec(path)?.[1];
  if (page) {
    let name: string;
    try { name = decodeURIComponent(page.split("/").at(-1)!).replace(/^@/, ""); } catch { throw new FeedInputError("Invalid channel URL encoding."); }
    if (/^[\p{L}\p{M}\p{N}_.-]{1,100}$/u.test(name)) return { channelPage: `https://www.youtube.com${page}` };
  }
  throw new FeedInputError("Unsupported YouTube URL. Use /channel/UC…, /@handle, /c/name, /user/name or /playlist?list=PL….");
}
function allowedRequest(url: string, mode: "feed" | "page") {
  if (mode === "page") {
    try { return "channelPage" in parseFeedInput(url); } catch { return false; }
  }
  try {
    const u = new URL(url);
    if (u.origin !== "https://www.youtube.com" || u.pathname !== "/feeds/videos.xml" || u.hash) return false;
    const keys = [...u.searchParams.keys()];
    if (keys.length !== 1) return false;
    const kind = keys[0] === "channel_id" ? "channel" : keys[0] === "playlist_id" ? "playlist" : null;
    return !!kind && feedIdentity(kind, u.searchParams.get(keys[0]!)!).feedUrl === u.href;
  } catch { return false; }
}
async function boundedText(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new FeedFetchError("YouTube returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new FeedFetchError("YouTube response exceeded the safe size limit.");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}
async function request(url: string, mode: "feed" | "page", headers: Record<string, string>, fetcher: typeof fetch) {
  const signal = AbortSignal.timeout(20000);
  let target = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedRequest(target, mode)) throw new FeedFetchError("Blocked an unsupported YouTube redirect.");
    let response: Response;
    try { response = await fetcher(target, { redirect: "manual", signal, headers: { Accept: mode === "feed" ? "application/atom+xml, application/xml" : "text/html", ...headers } }); }
    catch { throw new FeedFetchError("YouTube request failed or timed out. The next feed check will retry."); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new FeedFetchError("YouTube returned a redirect without a destination.");
      try { target = new URL(location, target).href; } catch { throw new FeedFetchError("Invalid YouTube redirect."); }
      // ID channel URLs are safe destinations for personalized URL redirects.
      if (mode === "page") {
        let resolved: ReturnType<typeof parseFeedInput>;
        try { resolved = parseFeedInput(target); } catch { throw new FeedFetchError("Blocked an unsupported YouTube redirect."); }
        if ("kind" in resolved && resolved.kind === "channel") return { identity: resolved, response: null, text: "" };
      }
      continue;
    }
    if (response.status === 304 && mode === "feed") return { response, text: "", identity: null };
    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedFetchError(`YouTube returned HTTP ${response.status}. Feed may be unavailable, private or deleted; no uploads were marked seen.`);
    }
    try { return { response, text: await boundedText(response, mode === "feed" ? 524288 : 2097152), identity: null }; }
    catch (error) { if (error instanceof FeedFetchError) throw error; throw new FeedFetchError("YouTube response interrupted or timed out."); }
  }
  throw new FeedFetchError("Too many YouTube redirects.");
}
export async function resolveFeed(source: string, fetcher = fetch): Promise<FeedIdentity> {
  const parsed = parseFeedInput(source);
  if ("kind" in parsed) return parsed;
  const result = await request(parsed.channelPage, "page", {}, fetcher);
  if (result.identity) return result.identity;
  // Public channel pages advertise this feed link. Never fetch a URL copied out of HTML.
  const id = /https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})(?=["'&<\s])/i.exec(result.text)?.[1]
    ?? /<meta\b[^>]*itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/i.exec(result.text)?.[1];
  if (!id) throw new FeedInputError("Could not resolve this channel from bounded public YouTube metadata. Paste its UC channel ID instead.");
  return feedIdentity("channel", id);
}
export function parseYoutubeFeed(xml: string): { title: string; entries: FeedEntry[] } {
  if (Buffer.byteLength(xml) > 524288 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new FeedFetchError("Unsafe or oversized feed XML was rejected.");
  if (XMLValidator.validate(xml) !== true) throw new FeedFetchError("Malformed feed XML. No uploads were marked seen.");
  try {
    const data = new XMLParser({ ignoreAttributes: false, processEntities: false, maxNestedTags: 20, parseTagValue: false, isArray: (name) => name === "entry" }).parse(xml);
    const feed = data.feed;
    if (!feed || feed["@_xmlns"] !== "http://www.w3.org/2005/Atom" || (feed.entry?.length && feed["@_xmlns:yt"] !== "http://www.youtube.com/xml/schemas/2015")) throw new Error();
    const entries: FeedEntry[] = (feed.entry ?? []).map((e: Record<string, unknown>) => {
      const videoId = e["yt:videoId"];
      if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) throw new Error();
      return { videoId, title: typeof e.title === "string" ? e.title.slice(0, 300) : `YouTube video ${videoId}` };
    });
    if (entries.length > 100) throw new Error();
    return { title: typeof feed.title === "string" ? feed.title.slice(0, 300) : "YouTube feed", entries: [...new Map(entries.map((e) => [e.videoId, e])).values()] };
  } catch { throw new FeedFetchError("Unsupported or malformed YouTube Atom feed. No uploads were marked seen."); }
}
export async function fetchYoutubeFeed(identity: FeedIdentity, validators: { etag?: string | null; lastModified?: string | null } = {}, fetcher = fetch): Promise<FeedResult> {
  const headers: Record<string, string> = {};
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  const { response, text } = await request(feedIdentity(identity.kind, identity.providerId).feedUrl, "feed", headers, fetcher);
  if (!response) throw new FeedFetchError("Unexpected feed resolution.");
  const etag = response.headers.get("etag")?.slice(0, 512) ?? null, lastModified = response.headers.get("last-modified")?.slice(0, 512) ?? null;
  return response.status === 304 ? { unchanged: true, entries: [], etag, lastModified }
    : { unchanged: false, ...parseYoutubeFeed(text), etag, lastModified };
}
