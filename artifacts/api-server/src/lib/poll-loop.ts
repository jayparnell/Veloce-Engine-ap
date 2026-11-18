export interface PollObserver {
  started(): void;
  succeeded(): void;
  failed(): void;
}

/** Stop synchronously blocks new polls and asynchronously waits for the current one. */
export function startPollLoop(task: () => Promise<void>, delay: number, onError: (error: unknown) => void, observer?: PollObserver) {
  let stopped = false;
  let failures = 0;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped || active) return;
    let nextDelay = delay;
    active = Promise.resolve().then(async () => {
      if (stopped) return;
      observer?.started();
      await task();
      failures = 0;
      observer?.succeeded();
    }).catch((error) => {
      failures++;
      nextDelay = Math.min(60000, delay * 2 ** Math.min(failures - 1, 6));
      observer?.failed();
      // Even a diagnostic callback must not create an unhandled background rejection.
      try { onError(error); } catch { /* the poll remains failed and will retry */ }
    }).finally(() => {
      active = undefined;
      if (!stopped) timer = setTimeout(tick, nextDelay);
    });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
