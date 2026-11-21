/** [COMP:app-web/live-watch-pane] Bounded-rate, single-flight read recovery.
 * No cache, authority or replay: callers apply only freshly authorized reads.
 * A hidden or disposed surface never starts another request. In-flight reads
 * remain the caller's responsibility (session/epoch fencing on application).
 */
export function createVisibleRecoveryLoop({
  recover,
  isVisible,
  intervalMs = 5_000,
}: {
  recover: () => Promise<unknown>;
  isVisible: () => boolean;
  intervalMs?: number;
}) {
  const delay = Number.isFinite(intervalMs) ? Math.max(1_000, Math.min(30_000, intervalMs)) : 5_000;
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!disposed && isVisible()) timer = setTimeout(wake, delay);
  };
  function wake() {
    clear();
    if (disposed || inFlight || !isVisible()) return;
    inFlight = true;
    void Promise.resolve().then(() => {
      if (!disposed && isVisible()) return recover();
    }).catch(() => {
      // A read failure is not an empty result and must not end recovery.
    }).finally(() => {
      inFlight = false;
      schedule();
    });
  }
  return {
    wake,
    pause: clear,
    dispose() { disposed = true; clear(); },
  };
}
