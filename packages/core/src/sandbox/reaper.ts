/**
 * Sandbox lifecycle sweep (§4.10): the orphan reaper kills + fails tasks
 * idle past the abandonment window (the O3 Take-Over wait default, ~20 min),
 * and periodically runs the vault's per-plan inactivity purge. Constructed
 * at boot, started only on the workers service (`runWorkers`) — the
 * workflow-lifecycle worker pattern.
 *
 * [COMP:sandbox/lifecycle]
 */
import type { SandboxOrchestrator } from './orchestrator.js'
import type { SessionVault } from './types.js'

export const DEFAULT_ABANDONMENT_MS = 20 * 60 * 1000
export const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000

export type SandboxReaperEvent = { type: 'tick'; reaped: number; purged: number }

export function createSandboxReaper(deps: {
  orchestrator: SandboxOrchestrator
  vault?: SessionVault | null
  abandonmentMs?: number
  intervalMs?: number
  onEvent?: (event: SandboxReaperEvent) => void
  now?: () => number
}): { start(): void; stop(): void; tick(): Promise<{ reaped: number; purged: number }> } {
  const now = deps.now ?? Date.now
  const abandonmentMs = deps.abandonmentMs ?? DEFAULT_ABANDONMENT_MS
  const intervalMs = deps.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let lastPurgeAt: number | null = null

  async function tick(): Promise<{ reaped: number; purged: number }> {
    const reaped = await deps.orchestrator.reapStale(abandonmentMs)
    let purged = 0
    if (deps.vault?.purgeInactive && (lastPurgeAt === null || now() - lastPurgeAt >= PURGE_EVERY_MS)) {
      lastPurgeAt = now()
      purged = await deps.vault.purgeInactive().catch(() => 0)
    }
    try {
      deps.onEvent?.({ type: 'tick', reaped, purged })
    } catch {
      /* observers must not break the sweep */
    }
    return { reaped, purged }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick().catch((err) => console.error('[sandbox-reaper] tick failed:', err))
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
