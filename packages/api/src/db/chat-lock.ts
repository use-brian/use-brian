/**
 * Per-chat message sequentialization — row-lease edition.
 *
 * Only one turn per `chatKey` runs at a time, across every API instance
 * sharing the database. Two prior designs failed in production:
 *
 *   1. In-memory `Map` chains (pre-OSS): no cross-instance or cross-restart
 *      guarantee.
 *   2. Session-level `pg_advisory_lock` on a pooled connection: a session
 *      lock belongs to the CONNECTION, so lock-hold = connection-hold. First
 *      it leaked (unlock skipped before pool release — the 2026-07-14 GM Bro
 *      silent-Telegram incident), and once the leak was fixed the pin itself
 *      was the bug: every running chat turn held one of the instance's
 *      `PG_POOL_MAX=2` system-pool slots for the turn's full duration while
 *      the turn's own queries drew on the same pool. A burst of concurrent
 *      turns left zero free slots and the newest turn's first query died at
 *      `connectionTimeoutMillis` with `timeout exceeded when trying to
 *      connect` (the 2026-07-14 Terry AI silent-Telegram incident, same
 *      evening).
 *
 * This version follows `withWorkerLock` (memories.ts), which replaced the
 * identical advisory-lock pattern for worker ticks after the 2026-05-25 pool
 * exhaustion: a lease ROW in `chat_turn_locks` (migration 325). Acquire,
 * heartbeat, and release are each a single fast statement on the system pool
 * — **no connection is held while `fn()` runs**, so chat locking can never
 * starve the pools regardless of how many turns run concurrently. This also
 * makes the lock safe in `PG_SINGLE_CONNECTION=1` (embedded PGLite) mode,
 * where the old design self-deadlocked: the lock checkout WAS the pool's
 * only connection, so the turn's first query could never run.
 *
 * Ordering: same-instance callers for one `chatKey` queue on an in-process
 * FIFO promise chain (only the queue head touches the DB). Cross-instance
 * contention — rare: the api runs single-instance, so this is deploy-overlap
 * and future scale-out — is resolved by lease polling, which is mutual
 * exclusion without strict FIFO. Crash recovery: a dead holder's row is
 * reclaimed via `expires_at` takeover (≤ TTL, heartbeat-extended while the
 * turn runs), instead of the advisory lock's instant-on-disconnect release.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Per-Chat
 * Sequentialization".
 */

import { randomUUID } from 'node:crypto'
import { query } from './client.js'

/**
 * Upper bound on how long a caller queues for its turn (in-process chain wait
 * + lease polling combined). A legitimate hold lasts one chat turn, so this
 * should never fire in normal operation — it exists so a pathological holder
 * (a wedged turn) surfaces as a loud error in the channel route's catch
 * instead of an unbounded, invisible hang.
 */
const CHAT_LOCK_WAIT_TIMEOUT_MS = 600_000

/**
 * Lease TTL. Heartbeats extend it on a 1/3-TTL cadence while the turn runs
 * (turns routinely outlive any fixed TTL — tool loops, computer-use), so the
 * TTL only matters after a crash: a dead holder's chat unblocks within one
 * TTL. 90s matches withWorkerLock — ~3 heartbeats per window, survives a
 * missed beat.
 */
const CHAT_LOCK_TTL_MS = 90_000

/** Cross-instance acquire poll cadence. Same-instance waiters never poll. */
const CHAT_LOCK_POLL_MS = 500

/**
 * Test seams only — production callers pass nothing. `waitTimeoutMs` bounds
 * the total queue wait, `ttlMs` the lease window, `pollMs` the acquire poll.
 */
export type ChatLockOptions = {
  waitTimeoutMs?: number
  ttlMs?: number
  pollMs?: number
}

/**
 * Per-process FIFO tail per chatKey. Tails are settled-safe (never reject),
 * so a failed turn cannot poison the queue behind it; entries are removed
 * when the tail settles while still current, so the map stays bounded by the
 * number of chats with in-flight work.
 */
const localChains = new Map<string, Promise<void>>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Execute `fn` while holding the chat-turn lease for `chatKey`.
 * Only one caller per `chatKey` runs at a time across all API instances.
 * Throws when the total wait for the turn exceeds `waitTimeoutMs`.
 */
export async function withChatLock<T>(
  chatKey: string,
  fn: () => Promise<T>,
  opts?: ChatLockOptions,
): Promise<T> {
  // Deadline covers the whole queue wait: time spent behind same-instance
  // predecessors in the local chain AND lease polling against other
  // instances both count against it.
  const deadline = Date.now() + (opts?.waitTimeoutMs ?? CHAT_LOCK_WAIT_TIMEOUT_MS)

  const prev = localChains.get(chatKey) ?? Promise.resolve()
  const run = prev.then(() => runWithLease(chatKey, fn, deadline, opts))
  let tail: Promise<void>
  tail = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (localChains.get(chatKey) === tail) localChains.delete(chatKey)
    })
  localChains.set(chatKey, tail)
  return run
}

async function runWithLease<T>(
  chatKey: string,
  fn: () => Promise<T>,
  deadline: number,
  opts?: ChatLockOptions,
): Promise<T> {
  const ttlMs = opts?.ttlMs ?? CHAT_LOCK_TTL_MS
  const pollMs = opts?.pollMs ?? CHAT_LOCK_POLL_MS
  const holderId = randomUUID()

  // (1) Acquire. UPSERT — INSERT if no row, take over on conflict only when
  // the existing row has expired (a crashed holder). When the row exists and
  // is live, the conditional UPDATE is skipped and RETURNING yields no row —
  // poll until the holder releases or the deadline passes. Each attempt is
  // one fast statement; no connection is retained between attempts.
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `withChatLock: timed out waiting for the chat turn lease on ${chatKey} ` +
          `(a prior turn held it past the wait bound; see chat_turn_locks)`,
      )
    }
    const ack = await query<{ acquired: boolean }>(
      `INSERT INTO chat_turn_locks (chat_key, holder_id, expires_at, acquired_at)
       VALUES ($1, $2::uuid, now() + ($3 || ' milliseconds')::interval, now())
       ON CONFLICT (chat_key) DO UPDATE
         SET holder_id   = EXCLUDED.holder_id,
             expires_at  = EXCLUDED.expires_at,
             acquired_at = EXCLUDED.acquired_at
         WHERE chat_turn_locks.expires_at < now()
       RETURNING (holder_id = $2::uuid) AS acquired`,
      [chatKey, holderId, String(ttlMs)],
    )
    if (ack.rows[0]?.acquired) break
    await sleep(pollMs)
  }

  // (2) Heartbeat. Extends the lease while fn() runs, gated on holder_id so
  // a stale beat after an expiry takeover is a no-op, not a hijack. Failures
  // are swallowed: the lease simply expires and a peer may reclaim it —
  // failing the user's turn on a heartbeat glitch is the wrong trade.
  const heartbeat = setInterval(() => {
    void query(
      `UPDATE chat_turn_locks
          SET expires_at = now() + ($2 || ' milliseconds')::interval
        WHERE chat_key = $1 AND holder_id = $3::uuid`,
      [chatKey, String(ttlMs), holderId],
    ).catch(() => {
      /* lease will expire; a peer reclaims via the ON CONFLICT branch */
    })
  }, Math.max(1_000, Math.floor(ttlMs / 3)))
  heartbeat.unref?.()

  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    // (3) Release, gated on holder_id so we never delete a row a peer took
    // over after our lease expired. Errors are swallowed: at worst the row
    // lingers until its TTL and the next acquire reclaims it.
    await query(`DELETE FROM chat_turn_locks WHERE chat_key = $1 AND holder_id = $2::uuid`, [
      chatKey,
      holderId,
    ]).catch(() => {})
  }
}
