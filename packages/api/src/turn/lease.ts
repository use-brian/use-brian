/**
 * Turn admission and the turn lease, for every runner (unified-sessions D11,
 * D14). `sessions.status='running'` is a lock; this module is the only code
 * that takes or releases it (graded by `invariants/turn-lease-everywhere`).
 *
 * Admission is decided by AUDIENCE (`sessionPolicy(kind).admission`):
 *   - `personal`: a fresh lease rejects (`turn_in_flight`), a stale one is
 *     reclaimed, then the slot is taken;
 *   - `room` (every workspace session): the slot is claimed atomically; a
 *     loser waits for it (the runner owns the wait, because only the runner
 *     can tell its client "queued").
 *
 * Spec: docs/architecture/context-engine/session-messages.md -> "Turn lease
 * and recovery"; docs/architecture/engine/turn-kernel.md.
 *
 * [COMP:api/turn-kernel]
 */
import {
  claimTurnSlot,
  isTurnLeaseLive,
  reclaimStaleTurn,
  releaseTurnLease,
  startTurnLease,
  takeTurnSlot,
  touchTurnLease,
  TURN_HEARTBEAT_INTERVAL_MS,
  type TurnEndReason,
} from '../db/sessions.js'

export type LiveTurnAdmission = 'proceed' | 'reclaim' | 'reject'

/**
 * Personal-admission guard against taking a slot a LIVE turn still holds.
 * Pure so the invariant is testable; the caller resolves `leaseLive` with
 * `isTurnLeaseLive` only when it matters (`status='running'` and the client
 * did not say `midTurn`).
 *
 *   - `proceed` - no turn is running, or the client is mid-turn (that path
 *                 queues into the running turn), or this is room admission
 *                 (rooms claim atomically and reclaim stale leases themselves).
 *   - `reclaim` - the row says running but the lease is stale: the holder is
 *                 dead. Reclaim it (recording `stalled_reclaimed`) and run.
 *   - `reject`  - the row says running AND the lease is fresh: a turn is
 *                 provably alive and this client just cannot see its stream.
 */
export function liveTurnAdmission(params: {
  status: string
  clientMidTurn: boolean
  isRoom: boolean
  /** `isTurnLeaseLive` for this session - only consulted when it can matter. */
  leaseLive: boolean
}): LiveTurnAdmission {
  if (params.status !== 'running') return 'proceed'
  if (params.clientMidTurn) return 'proceed'
  if (params.isRoom) return 'proceed'
  return params.leaseLive ? 'reject' : 'reclaim'
}

/** A runner's pre-persistence admission check (personal sessions). */
export async function precheckTurnAdmission(params: {
  sessionId: string
  status: string
  admission: 'personal' | 'room'
  clientMidTurn: boolean
}): Promise<LiveTurnAdmission> {
  const isRoom = params.admission === 'room'
  const needsLeaseCheck = params.status === 'running' && !params.clientMidTurn && !isRoom
  return liveTurnAdmission({
    status: params.status,
    clientMidTurn: params.clientMidTurn,
    isRoom,
    leaseLive: needsLeaseCheck ? await isTurnLeaseLive(params.sessionId) : false,
  })
}

export type TurnSlotOutcome =
  | { taken: true; token: string }
  | { taken: false; code: 'turn_in_flight' | 'room_turn_wait_timeout' }

/**
 * Take the turn slot and its lease. `waitForSlot` resolves true when the
 * room's in-flight turn finished (false = gave up); without it a room loser
 * is refused at once (a runner with no client to tell "queued").
 */
export async function takeTurnLease(params: {
  sessionId: string
  admission: 'personal' | 'room'
  waitForSlot?: (sessionId: string) => Promise<boolean>
}): Promise<TurnSlotOutcome> {
  const { sessionId } = params
  if (params.admission === 'room') {
    let claimed = await claimTurnSlot(sessionId)
    while (!claimed) {
      // A lease that went stale while we waited is reclaimed rather than
      // waited out: the holder is gone, not slow.
      if (await reclaimStaleTurn(sessionId)) {
        claimed = await claimTurnSlot(sessionId)
        if (claimed) break
      }
      if (!params.waitForSlot || !(await params.waitForSlot(sessionId))) {
        return { taken: false, code: params.waitForSlot ? 'room_turn_wait_timeout' : 'turn_in_flight' }
      }
      claimed = await claimTurnSlot(sessionId)
    }
  } else {
    if (await isTurnLeaseLive(sessionId)) return { taken: false, code: 'turn_in_flight' }
    await reclaimStaleTurn(sessionId)
    await takeTurnSlot(sessionId)
  }
  return { taken: true, token: await startTurnLease(sessionId) }
}

/**
 * Heartbeat the lease. A lost lease (reclaimed while we were away) or a stop
 * request read back by the same statement calls the matching hook; the caller
 * aborts. Deliberately a wall-clock interval, not loop progress: a turn
 * suspended on a confirmation is alive and keeps its lease.
 */
export function startLeaseHeartbeat(params: {
  sessionId: string
  token: string
  onLost: () => void
  onCancelRequested: () => void
  intervalMs?: number
}): () => void {
  let stopped = false
  const timer = setInterval(() => {
    void touchTurnLease(params.sessionId, params.token)
      .then(({ held, cancelRequested }) => {
        if (stopped) return
        if (!held) params.onLost()
        else if (cancelRequested) params.onCancelRequested()
      })
      .catch((err) => {
        // A failed tick is not fatal: the next one retries, and the sweeper
        // is the backstop if they all fail.
        console.warn('[turn-lease] heartbeat failed:', err)
      })
  }, params.intervalMs ?? TURN_HEARTBEAT_INTERVAL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** Release the lease (token-guarded; idempotent). */
export async function releaseTurn(sessionId: string, token: string, reason: TurnEndReason = 'completed'): Promise<boolean> {
  try {
    return await releaseTurnLease(sessionId, reason, token)
  } catch (err) {
    // Nothing left to fall back on but the sweeper, which now reads the
    // lease we failed to clear, so it WILL fire.
    console.error('[turn-lease] failed to release turn lease:', err)
    return false
  }
}
