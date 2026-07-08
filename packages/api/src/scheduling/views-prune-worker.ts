/**
 * Views auto-prune worker.
 *
 * Notion-redesign of Q5 Views: chat-driven `renderView` calls create a
 * draft `saved_views` row server-side. If the user never opens the
 * draft to save it (or to explicitly delete it), we want it to garbage-
 * collect — chat history grows fast and 99% of drafts will never be
 * touched again.
 *
 * This worker runs daily, deletes every draft whose `auto_prune_at` is
 * in the past. The DB does the heavy lift via a partial index on
 * `(auto_prune_at) WHERE state='draft' AND auto_prune_at IS NOT NULL`
 * (migration 184) so the sweep is cheap regardless of total row count.
 *
 * Mirrors the stuck-session-sweeper pattern: a single SQL statement,
 * idempotent ticks, never throws past the catch.
 *
 * Component tag: [COMP:scheduling/views-prune-worker].
 * Doc: docs/architecture/features/views.md.
 */

import type { SavedViewStore } from '@sidanclaw/core'

/**
 * Default tick cadence. Daily — drafts have a 30-day TTL by default,
 * so once-a-day is plenty fine-grained.
 */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

export type ViewsPruneWorkerDeps = {
  /** The saved-view store. Production wires `createDbSavedViewStore()`. */
  savedViewStore: SavedViewStore
  /** Test-only error hook. Defaults to `console.error`. */
  onError?: (err: unknown) => void
}

export type ViewsPruneWorkerOptions = ViewsPruneWorkerDeps & {
  /** Tick cadence. Default `DEFAULT_INTERVAL_MS` (24h). */
  intervalMs?: number
  /** If true, runs an immediate tick on `start()`. Production: yes; tests: false. */
  runImmediately?: boolean
}

export function createViewsPruneWorker(options: ViewsPruneWorkerOptions) {
  const savedViewStore = options.savedViewStore
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const runImmediately = options.runImmediately ?? true
  const onError = options.onError ?? ((err) => console.error('[views-prune-worker] tick failed:', err))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const pruned = await savedViewStore.pruneExpiredDraftsSystem()
      if (pruned.length > 0) {
        console.log(`[views-prune-worker] pruned ${pruned.length} expired draft view(s)`)
      }
    } catch (err) {
      // A single tick failure must not crash the host process.
      onError(err)
    } finally {
      running = false
    }
  }

  return {
    /** Run one tick immediately. Exposed for tests and operator triggers. */
    tick,
    start() {
      if (timer) return
      console.log(`[views-prune-worker] worker started (interval: ${intervalMs}ms)`)
      timer = setInterval(() => { void tick() }, intervalMs)
      if (runImmediately) void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[views-prune-worker] worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
