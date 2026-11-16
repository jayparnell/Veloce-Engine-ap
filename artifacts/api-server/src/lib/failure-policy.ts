/** Shared by persisted errors and logs. Never log provider payloads, tokens or signed URLs. */
export function redactError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown failure")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/(?:\/home\/|\/tmp\/)[^\s"'<>]+/g, "[local file]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|cookie|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
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
