import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProxyAgent } from "undici";

export const YOUTUBE_COOKIE_FILE = "/tmp/youtube_cookies.txt";
type NetworkEnvironment = { PROXY_URL?: string; YOUTUBE_COOKIES?: string };
export function configuredProxy(env: NetworkEnvironment = process.env): string | undefined {
  const proxy = env.PROXY_URL;
  if (!proxy) return undefined;
  try {
    const url = new URL(proxy);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.hash || url.search) throw new Error();
  } catch {
    // Do not interpolate a URL, parser exception, username or password here.
    throw new Error("Invalid PROXY_URL configuration. Use an HTTP or HTTPS residential proxy URL; credentials must be URL-encoded. No direct request was attempted.");
  }
  return proxy;
}

/** Atomic, owner-only replacement: readers never observe a half-written cookie jar. */
export async function writeYouTubeCookies(contents: string, destination = YOUTUBE_COOKIE_FILE) {
  if (Buffer.byteLength(contents) > 1024 * 1024 || contents.includes("\0") ||
    !/^\s*# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(contents)) {
    throw new Error("Invalid YOUTUBE_COOKIES configuration. Supply the contents of a Netscape-format cookie file, up to 1 MB. Cookie contents were not logged.");
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(contents, "utf8"); }
    finally { await file.close(); }
    await rename(temporary, destination);
  } catch {
    throw new Error("Could not prepare the private YouTube cookie file. Cookie contents were not logged.");
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Called at the subprocess boundary, covering metadata, audio, ranges and VOD fallbacks. */
export async function prepareYtdlpArguments(args: string[], env: NetworkEnvironment = process.env, writeCookies = writeYouTubeCookies) {
  const proxy = configuredProxy(env);
  if (env.YOUTUBE_COOKIES) await writeCookies(env.YOUTUBE_COOKIES);
  const options = [
    ...(proxy ? ["--proxy", proxy] : []),
    ...(env.YOUTUBE_COOKIES ? ["--cookies", YOUTUBE_COOKIE_FILE] : []),
  ];
  // Never append options after "--", where yt-dlp would treat them as source URLs.
  const separator = args.indexOf("--");
  return separator === -1 ? [...args, ...options] : [...args.slice(0, separator), ...options, ...args.slice(separator)];
}

/** Do not set a global dispatcher: AI, storage and social requests must stay unchanged. */
export async function withCaptionResponse<T>(
  url: URL,
  consume: (response: Response) => Promise<T>,
  env: NetworkEnvironment = process.env,
  fetcher: typeof fetch = fetch,
) {
  const proxy = configuredProxy(env);
  const dispatcher = proxy ? new ProxyAgent({ uri: proxy }) : undefined;
  const signal = AbortSignal.timeout(8000);
  try {
    const response = await fetcher(url, {
      redirect: "error", signal, ...(dispatcher ? { dispatcher } : {}),
    });
    try { return await consume(response); }
    finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  } finally {
    // Destroy also closes connections for rejected, oversized or unconsumed responses.
    if (dispatcher) await dispatcher.destroy();
  }
}
