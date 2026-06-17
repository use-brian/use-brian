/**
 * Stuck-session sweeper.
 *
 * Periodically resets sessions that are still `status='running'` past the
 * point where any in-flight chat turn could legitimately be making progress.
 *
 * Why this exists: the chat route flips `status` to `'running'` at the top
 * of a turn and back to `'idle'` in either the success path or the catch
 * block. Both paths can be skipped if the request handler never returns —
 * which is what happened when a hung Gemini fetch ran past Cloud Run's 300s
 * cap. The container truncates the response, but the JS promise chain stays
 * parked in the still-pending `await fetch(...)`, so the cleanup
 * `updateSessionStatus(..., 'idle')` never fires. The result was a draft
 * session displaying "another team member is in a turn" forever (the
 * `draft_session_busy` 409 guard) until the row was manually edited.
 *
 * The provider-side fix that prevents the hang in the first place
 * (`wrapProvider` activating `wrapIdleTimeout`, plus `AbortSignal` plumbed
 * to `fetch`) is the primary defence. This sweeper is the belt to that
 * fix's braces — any future hang we don't anticipate still gets recovered
 * automatically.
 *
 * Component tag: [COMP:scheduling/stuck-session-sweeper].
 * Doc: docs/architecture/context-engine/session-messages.md
 *      → "Stuck-running recovery".
 */

import { sweepStuckSessions } from '../db/sessions.js'

/**
 * Default staleness threshold. Comfortably past Cloud Run's 300s request cap
 * so a session whose chat turn is *still legitimately running* is never
 * reset. Increase this if you ever raise Cloud Run's `timeoutSeconds`
 * past 5 minutes.
 */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 1000

/**
 * Default tick cadence. Matches the cron poll worker (60s) — frequent
 * enough that a stuck session is recoverable on the user's next page
 * refresh, infrequent enough that a single instance's DB load is
 * negligible.
 */
export const DEFAULT_INTERVAL_MS = 60 * 1000

export type StuckSessionSweeperDeps = {
  /**
   * Single SQL UPDATE that flips every stale `'running'` session to
   * `'timeout'` and returns the affected rows. Production wires this to
   * `sweepStuckSessions` from `db/sessions.ts`. Tests inject a fake.
   */
  sweep?: (staleAfterMs: number) => Promise<Array<{ id: string; mode: string | null; userId: string }>>
  /**
   * Publishes a `turn_completed` bus event for draft-mode rows so any
   * SSE subscriber on the same Cloud Run instance immediately unblocks
   * their UI's "another teammate is in a turn" indicator. No-op for
   * non-draft rows. Production wires this to `publishSessionEvent`; tests
   * pass a spy.
   */
  publishDraftTurnCompleted?: (sessionId: string) => void
  /** Pluggable clock for tests. Production leaves this undefined. */
  now?: () => Date
  /** Test-only error hook. Defaults to `console.error`. */
  onError?: (err: unknown) => void
}

export type StuckSessionSweeperOptions = StuckSessionSweeperDeps & {
  /** Tick cadence. Default `DEFAULT_INTERVAL_MS` (60s). */
  intervalMs?: number
  /** Staleness threshold. Default `DEFAULT_STALE_AFTER_MS` (6 min). */
  staleAfterMs?: number
}

export function createStuckSessionSweeper(options: StuckSessionSweeperOptions = {}) {
  const sweep = options.sweep ?? sweepStuckSessions
  // Open default: no feed draft bus -> no-op. The platform injects the real
  // `publishDraftTurnCompleted` (wired to the closed feed bus) at startup so the
  // open sweeper imports no closed code (oss-local-brain-wedge.md §12.5).
  const publish = options.publishDraftTurnCompleted ?? (() => {})
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const onError = options.onError ?? ((err) => console.error('[stuck-session-sweeper] tick failed:', err))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const swept = await sweep(staleAfterMs)
      if (swept.length === 0) return
      for (const row of swept) {
        console.warn(
          `[stuck-session-sweeper] reset session ${row.id} (mode=${row.mode ?? 'web'}, user=${row.userId}) status='running' → 'timeout'`,
        )
        if (row.mode === 'draft') {
          try {
            publish(row.id)
          } catch (err) {
            onError(err)
          }
        }
      }
      console.log(`[stuck-session-sweeper] swept ${swept.length} stuck session(s)`)
    } catch (err) {
      // A single tick failure must not crash the host process — the next
      // tick will try again 60s later.
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
      console.log(`[stuck-session-sweeper] worker started (interval: ${intervalMs}ms, stale: ${staleAfterMs}ms)`)
      timer = setInterval(() => { void tick() }, intervalMs)
      // Run immediately on boot — picks up any sessions that were stuck
      // when the previous instance was killed.
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[stuck-session-sweeper] worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
