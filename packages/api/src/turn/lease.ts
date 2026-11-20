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
import { query } from '../db/client.js'
import {
  claimTurnLeaseOutcome,
  touchTurnLease,
  TURN_HEARTBEAT_INTERVAL_MS,
  type TurnEndReason,
  releaseTurnOutcome,type ReleasedTurn,type RecoveredTurn,
} from '../db/sessions.js'

export class TurnLeaseLostError extends Error {
  readonly code='turn_lease_lost'
  readonly reason='ownership_lost'
  readonly retrySafe=false
  constructor(){super('The original turn no longer owns its lease.');this.name='TurnLeaseLostError'}
}
export class TurnStoppedError extends Error {
  readonly code='turn_stopped'
  readonly reason='stopped_by_user'
  constructor(){super('The original turn was stopped.');this.name='TurnStoppedError'}
}
export function turnAbortKind(signal:AbortSignal):'stop'|'lease_lost'|'abort'|null {
  if(!signal.aborted)return null
  if(signal.reason instanceof TurnLeaseLostError)return 'lease_lost'
  if(signal.reason instanceof TurnStoppedError)return 'stop'
  return 'abort'
}

export type TurnSlotWait = (sessionId: string, opts?: { signal?: AbortSignal }) => Promise<boolean>

export type TurnSlotOutcome =
  | { taken: true; token: string; turnId:string|null; reclaimed?: true; recovered?:RecoveredTurn }
  | { taken: false; code: 'turn_in_flight' | 'room_turn_wait_timeout' }

/**
 * Take the turn slot and its lease. `waitForSlot` resolves true when the
 * room's in-flight turn finished (false = gave up); without it a room loser
 * is refused at once (a runner with no client to tell "queued").
 */
export async function takeTurnLease(params: {
  sessionId: string
  admission: 'personal' | 'room'
  waitForSlot?: TurnSlotWait
  /** Reclaim is handled separately and fenced to the known predecessor. */
  idleOnly?: boolean
  signal?: AbortSignal
  /** The answering assistant when the runner re-addresses (see `claimTurnLease`). */
  assistantId?: string
  /** Includes attended request preparation in the visible elapsed time. */
  startedAt?: Date
}): Promise<TurnSlotOutcome> {
  // Claim and token creation are one atomic owner operation for every audience.
  // Waits remain transport-specific, and every wake attempts a fresh claim.
  for (;;) {
    params.signal?.throwIfAborted()
    const claim=await claimTurnLeaseOutcome(params.sessionId,params.assistantId??null,params.startedAt??null,
      ...(params.idleOnly ? [{ idleOnly: true } as const] : []))
    if(claim)return{taken:true,...claim,...claim.recovered?{reclaimed:true as const}:{}}
    params.signal?.throwIfAborted()
    if (!params.waitForSlot) return { taken: false, code: 'turn_in_flight' }
    const available = await params.waitForSlot(params.sessionId, { signal: params.signal })
    params.signal?.throwIfAborted()
    if (!available) return { taken: false, code: 'room_turn_wait_timeout' }
  }
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
export async function releaseTurn(sessionId: string, token: string, reason: TurnEndReason = 'completed',onReleased?:(result:ReleasedTurn)=>void): Promise<boolean> {
  try {
    const result=await releaseTurnOutcome(sessionId,reason,token)
    if(result)onReleased?.(result)
    return !!result
  } catch (err) {
    // Nothing left to fall back on but the sweeper, which now reads the
    // lease we failed to clear, so it WILL fire.
    console.error('[turn-lease] failed to release turn lease:', err)
    return false
  }
}

/**
 * How long a send waits for the in-flight turn's slot. MUST stay under the
 * hosting request cap (Cloud Run `timeoutSeconds`, 300s): a longer wait is
 * truncated by the platform at 301s and the sender gets a severed stream with
 * no reply and no error (2026-08-08). Keep a margin so the error is ours.
 * This bounds a wait for ANOTHER turn, not agentic work.
 */
export const TURN_SLOT_WAIT_TIMEOUT_MS = 240_000

/**
 * Wait until the session's turn slot frees (status leaves 'running'). A
 * status-only poll: deliberately NOT `findSessionById`, which touches
 * `last_active_at`. Resolves `false` on timeout.
 */
export async function waitForTurnSlot(
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? TURN_SLOT_WAIT_TIMEOUT_MS
  const pollMs = opts?.pollMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  const signal = opts?.signal
  for (;;) {
    signal?.throwIfAborted()
    const row = await query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [sessionId])
    signal?.throwIfAborted()
    const status = row.rows[0]?.status
    if (!status || status !== 'running') return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, Math.min(pollMs, Math.max(0, deadline - Date.now())))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }
}

/**
 * In-flight turns' abort handles, keyed by sessionId, for EVERY runner.
 * `POST /api/chat/stop` uses this when the turn runs in THIS process, so a
 * stop is instant rather than waiting on a heartbeat tick; a turn in another
 * process is reached through `sessions.cancel_requested_at`. Because the
 * kernel registers every leased turn here, a channel turn is as stoppable as
 * a web one.
 */
const activeTurnAborts = new Map<string, { token: string; abort: () => void }>()

export function registerTurnAbort(sessionId: string, token: string, abort: () => void): void {
  activeTurnAborts.set(sessionId, { token, abort })
}

/** Identity-guarded: never evicts a successor turn's handle. */
export function unregisterTurnAbort(sessionId: string, token: string): void {
  if (activeTurnAborts.get(sessionId)?.token === token) activeTurnAborts.delete(sessionId)
}

/** Abort the turn running in this process on `sessionId`. True when one was. */
export function abortLocalTurn(sessionId: string, token:string): boolean {
  const local = activeTurnAborts.get(sessionId)
  if (!local||local.token!==token) return false
  local.abort()
  return true
}
