export interface PollObserver {
  started(): void;
  succeeded(): void;
  failed(): void;
}

/** Stop synchronously blocks new polls and asynchronously waits for the current one. */
export function startPollLoop(task: () => Promise<void>, delay: number, onError: () => void, observer?: PollObserver) {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(async () => {
      if (stopped) return;
      observer?.started();
      await task();
      observer?.succeeded();
    }).catch(() => {
      observer?.failed();
      onError();
    }).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, delay);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
