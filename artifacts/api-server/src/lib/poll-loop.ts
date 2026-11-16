/** Stop synchronously blocks new polls and asynchronously waits for the current one. */
export function startPollLoop(task: () => Promise<void>, delay: number, onError: () => void) {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(async () => { if (!stopped) await task(); })
      .catch(onError).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, delay);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
