/** Predecessor admission for resuming an approved suspension. [COMP:api/turn-kernel] */
import { readResumePredecessorLease } from '../db/session-resume-store.js'
import { reclaimStaleTurnOutcome, TURN_LEASE_STALE_AFTER_MS, type RecoveredTurn } from '../db/sessions.js'
import { TURN_SLOT_WAIT_TIMEOUT_MS, waitForTurnSlot, type TurnSlotWait } from './lease.js'

export type ResumeSlotWaitOptions = { staleAfterMs?: number; pollMs?: number; timeoutMs?: number }

/**
 * The resume's slot wait (askquestion-suspend-resume.md → "Resumed turn
 * execution (D9)", step 1). The suspended turn's own lease, named by this
 * session's resume point, is the resume's predecessor: while it is fresh the
 * resume waits (a live process may still hold it); once its heartbeat is stale
 * the resume reclaims it through the sweeper's fenced `reclaimStaleTurnOutcome`
 * (`stalled_reclaimed` / `publication_recovered`), announces it, and lets the
 * owner claim, without waiting for a sweep tick. A fresh lease or one the resume
 * point does not name is never reclaimed here: it keeps the ordinary
 * `waitForTurnSlot` wait and fails closed at the timeout.
 */
export function resumePredecessorSlotWait(params: {
  approvalId: string
  onReclaimed: (recovered: RecoveredTurn) => void
  options?: ResumeSlotWaitOptions
}): TurnSlotWait {
  return async (sessionId, opts) => {
    // Resolved on use: a slot that is free on the first claim never waits.
    const staleAfterMs = params.options?.staleAfterMs ?? TURN_LEASE_STALE_AFTER_MS
    const pollMs = params.options?.pollMs ?? 2_000
    const deadline = Date.now() + (params.options?.timeoutMs ?? TURN_SLOT_WAIT_TIMEOUT_MS)
    for (;;) {
      opts?.signal?.throwIfAborted()
      const lease = await readResumePredecessorLease(sessionId, params.approvalId, staleAfterMs)
      opts?.signal?.throwIfAborted()
      if (!lease || !lease.running) return true
      if (lease.predecessorToken && lease.stale) {
        const recovered = await reclaimStaleTurnOutcome(sessionId, staleAfterMs, lease.predecessorToken)
        if (recovered) {
          params.onReclaimed(recovered)
          return true
        }
        continue // the lease changed under us: read it again
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      // The predecessor is re-checked every poll; any other lease waits as before.
      const freed = await waitForTurnSlot(sessionId, { signal: opts?.signal, pollMs,
        timeoutMs: lease.predecessorToken ? Math.min(pollMs, remaining) : remaining })
      if (freed) return true
      if (!lease.predecessorToken) return false
    }
  }
}
