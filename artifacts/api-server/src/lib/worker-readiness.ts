import type { PollObserver } from "./poll-loop";

/** Fixed messages only: never expose database exceptions, connection strings or jobs. */
export function pollReadiness(staleAfterMs: number, now = Date.now) {
  const createdAt = now();
  let lastStartedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let failed = false;
  let polling = false;
  const observer: PollObserver = {
    started() { lastStartedAt = now(); polling = true; },
    succeeded() { lastSuccessAt = now(); failed = false; polling = false; },
    failed() { lastFailureAt = now(); failed = true; polling = false; },
  };
  return {
    observer,
    snapshot() {
      const stale = now() - (lastSuccessAt ?? createdAt) > staleAfterMs;
      const state = failed ? polling ? "recovering" : "unavailable" : stale ? "stale" : lastSuccessAt === null ? "starting" : "ready";
      return {
        ready: state === "ready", state, polling, lastStartedAt, lastSuccessAt, lastFailureAt, staleAfterMs,
        error: failed ? "Queue poll failed. Database access may be temporarily unavailable."
          : stale ? "No successful queue poll within the readiness window." : null,
      };
    },
  };
}

export function workerReadiness(now = Date.now) {
  // Keep actual poll intervals unchanged: media 2s, publisher 60s.
  const media = pollReadiness(30000, now);
  const publisher = pollReadiness(150000, now);
  return {
    media, publisher,
    response(draining: boolean) {
      const polls = { media: media.snapshot(), publisher: publisher.snapshot() };
      const ready = !draining && polls.media.ready && polls.publisher.ready;
      return {
        status: ready ? 200 : 503,
        body: {
          running: !draining, ready,
          state: draining ? "draining" : ready ? "ready" : "not_ready",
          polls, scheduling: "Only while this service runs; not an uptime guarantee.",
        },
      };
    },
  };
}
