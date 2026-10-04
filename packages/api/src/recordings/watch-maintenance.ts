import { watchStore } from './watch-store.js'

/** Small bounded retention sweep, no overlapping work; shutdown drains in-flight SQL. */
export function startWatchCleanup(cleanup = () => watchStore.cleanup(), intervalMs = 15 * 60 * 1000) {
  let pending: Promise<void> | undefined
  const tick = () => {
    if (!pending) pending = cleanup().catch(() => {
      console.warn('[watch-recording] retention sweep failed; will retry')
    }).finally(() => { pending = undefined })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return async () => { clearInterval(timer); await pending }
}
