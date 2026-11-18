import { createHash } from "node:crypto";

export const MAX_AI_ATTEMPTS = 4; // Initial request + three explicitly authorized retries.
export const attemptKey = (key: string) => `ai-attempt:${key}`;
export const requestKey = (owner: string, job: number, key: string) =>
  createHash("sha256").update(`${owner}:${job}:${key}`).digest("hex");
export function retryDate(attempt: number, headers?: { get(name: string): string | null }, now = Date.now()) {
  const header = headers?.get("retry-after");
  const after = header ? (/^\d+(\.\d+)?$/.test(header) ? now + Number(header) * 1000 : Date.parse(header)) : 0;
  return new Date(Math.max(now + Math.min(30000, 2000 * 2 ** Math.max(0, attempt - 1)), Number.isFinite(after) ? after : 0));
}
// Compatibility export name is retained for historical consumers; it no longer means an approval hold.
export class UncertainCallError extends Error {}
export class AIRetryScheduled extends UncertainCallError {
  constructor(public notBefore: Date, public attempt: number) {
    super(`AI request will retry automatically after ${notBefore.toISOString()} (attempt ${attempt}/${MAX_AI_ATTEMPTS}). Previous uncertain usage remains recorded.`);
  }
}
export class AIRetriesExhausted extends Error {
  constructor() { super("AI request failed after the initial attempt and three automatic retries. Saved results and usage history are preserved; fix provider access or retry the job deliberately."); }
}
