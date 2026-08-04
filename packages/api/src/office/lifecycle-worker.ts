/** Retention clock: Trash -> Retained -> Purged, preserving legal holds and
 * pinned template dependencies. Covered by [COMP:api/office-release]. */
export type OfficeTimedLifecycle = { state: 'trash' | 'retained'; retainAt: Date | null; purgeAt: Date | null; legalHold: boolean }

export function nextOfficeLifecycleState(value: OfficeTimedLifecycle, now: Date): 'retained' | 'purged' | null {
  if (value.legalHold) return null
  if (value.state === 'trash' && value.retainAt && value.retainAt <= now) return 'retained'
  if (value.state === 'retained' && value.purgeAt && value.purgeAt <= now) return 'purged'
  return null
}

export function createOfficeLifecycleWorker(deps: { sweep(): Promise<number>; intervalMs?: number }) {
  let timer: ReturnType<typeof setInterval> | null = null
  const run = () => void deps.sweep().then((count) => { if (count) console.log(`[office-lifecycle] advanced ${count} retained item(s)`) }).catch((error) => console.error('[office-lifecycle] sweep failed:', error))
  return {
    start() { if (!timer) { run(); timer = setInterval(run, deps.intervalMs ?? 60 * 60 * 1000); timer.unref?.() } },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
}
