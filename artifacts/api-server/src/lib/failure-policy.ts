import { OpenAIRequestError } from "./openai-error";
/** Provider diagnostics are preserved verbatim except credential material. */
export function redactError(error: unknown, env: { PROXY_URL?: string } = process.env) {
  let message = error instanceof Error ? error.message : "Unknown failure";
  // A bounded stderr buffer can start midway through a credential-bearing URL.
  // Remove its configured password too, not just complete URL-shaped strings.
  if (env.PROXY_URL) {
    message = message.split(env.PROXY_URL).join("[redacted proxy]");
    try {
      const password = new URL(env.PROXY_URL).password;
      for (const value of new Set([password, decodeURIComponent(password)])) {
        if (value) message = message.split(value).join("[redacted]");
      }
    } catch { /* Invalid proxy input is rejected without echoing its value. */ }
  }
  if (error instanceof OpenAIRequestError) {
    const key = process.env.OPENAI_API_KEY;
    if (key) message = message.split(key).join("[redacted key]");
    return message
      .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(/\bsk-[A-Za-z0-9_.*-]+/g, "[redacted key]");
  }
  return message
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(?:https?|socks4a?|socks5h?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/(?:\/home\/|\/tmp\/)[^\s"'<>]+/g, "[local file]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|cookie|proxy_url|youtube_cookies|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/^.*\t(?:TRUE|FALSE)\t.*$/gm, "[redacted cookie entry]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted key]")
    .slice(0, 1800);
}
export function nextFailure(failures: number, now = new Date(), notBefore?: Date | null) {
  const count = failures + 1;
  return { count, status: count < 2 ? "retry" : "failed",
    retryAt: count < 2 ? new Date(Math.max(now.getTime() + 60000, notBefore?.getTime() ?? 0)) : null };
}
export function permanentMediaFailure(error: unknown) {
  return /private|geo.block|DRM|sign.in|confirm.*bot|not available|forbidden|unauthoriz|permission|access denied|HTTP (?:Error )?(400|401|403|404|422)|Invalid |validation|Zod|No intelligible|Fewer than three|Source must|Source video must|exceeds|too long|unavailable|cannot be dubbed|checkpoint is unavailable|did not pass .*checks/i
    .test(`${error instanceof Error ? error.name : ""} ${error instanceof Error ? error.message : ""}`);
}
