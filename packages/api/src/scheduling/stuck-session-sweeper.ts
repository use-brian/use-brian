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
 * **The 2026-08-08 repair.** For rooms this sweeper was worse than absent, it
 * was *inverted*: staleness keyed off `last_active_at`, which `findSessionById`
 * rewrites on every read, so a member watching the stuck room refreshed the
 * clock faster than the threshold could expire. The sweep fired only once
 * everyone gave up looking — ~31 minutes late on a 6-minute threshold. It now
 * keys off the turn LEASE (`turn_heartbeat_at`, migration 424), which only a
 * running turn writes, and it broadcasts `turn_completed` for shared rooms as
 * well as drafts so live viewers stop showing "Working" without a reload.
 *
 * Component tag: [COMP:scheduling/stuck-session-sweeper].
 * Doc: docs/architecture/context-engine/session-messages.md
 *      → "Turn lease and recovery".
 */

import { sweepStuckSessions, TURN_LEASE_STALE_AFTER_MS } from '../db/sessions.js'

/**
 * Default staleness threshold — the turn lease's, since that is now the column
 * the sweep predicate reads.
 *
 * This deliberately no longer clears Cloud Run's 300s request cap the way the
 * old 6-minute `last_active_at` threshold did. It does not need to: a turn
 * still legitimately running past the cap keeps heart-beating (the heartbeat
 * interval is independent of the HTTP request), while a turn that has stopped
 * heart-beating is dead no matter how long its request was permitted to run.
 * Trading that margin away is what buys sub-2-minute recovery.
 */
export const DEFAULT_STALE_AFTER_MS = TURN_LEASE_STALE_AFTER_MS

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
  sweep?: (staleAfterMs: number) => Promise<Array<{ id: string; mode: string | null; userId: string; visibility: string }>>
  /**
   * Publishes a `turn_completed` bus event so any SSE subscriber immediately
   * unblocks their UI's "working" indicator. The bus is in-process **and**
   * cross-instance (LISTEN/NOTIFY), so this reaches viewers connected to the
   * API service even though the sweeper runs on the workers service.
   *
   * Called for draft-mode rows AND workspace-shared rooms. Rooms were the
   * omission behind the 2026-08-08 incident: the sweep healed the row, but
   * every open Live card kept showing "Working" until a manual reload, because
   * nothing told them. Production wires this to `publishSessionEvent`; tests
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
          `[stuck-session-sweeper] reset session ${row.id} (mode=${row.mode ?? 'web'}, visibility=${row.visibility}, user=${row.userId}) status='running' → 'timeout'`,
        )
        // Draft sessions AND workspace-shared rooms have live watchers whose
        // UI is pinned on the turn lifecycle. Healing the row without telling
        // them just moves the stuck state into the browser.
        if (row.mode === 'draft' || row.visibility === 'workspace') {
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
