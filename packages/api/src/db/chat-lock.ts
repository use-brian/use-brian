/**
 * Postgres advisory lock for per-chat message sequentialization.
 *
 * Replaces in-memory `chatLocks` Maps in channel routes. Advisory locks
 * survive API restarts and work across multiple API instances (all share
 * the same Cloud SQL database).
 *
 * Session-level advisory locks belong to the CONNECTION's session, not to
 * the pool checkout: `client.release()` returns the connection to the pool
 * with its session — and any advisory lock it still holds — intact. The
 * lock must therefore be explicitly `pg_advisory_unlock`ed before release;
 * when the unlock cannot be confirmed, the connection is destroyed
 * (`release(err)`) so Postgres closes the session and frees every lock it
 * held. The pre-2026-07-14 version skipped the unlock on the assumption
 * that returning the connection released the lock — the leaked lock rode
 * the pooled connection, and the next message for the same chat blocked
 * forever inside `pg_advisory_lock` with no error and no log (the GM Bro
 * Telegram silent-unresponsiveness incident). Spec:
 * docs/architecture/channels/adapter-pattern.md → "Per-Chat
 * Sequentialization".
 */

import { getPool } from './client.js'

/**
 * Upper bound on how long a caller queues behind another holder. A
 * legitimate hold lasts one chat turn, so this should never fire in normal
 * operation — it exists so a pathological holder (a leaked lock, a wedged
 * turn) surfaces as a loud `lock_timeout` error (55P03) in the channel
 * route's catch instead of an unbounded, invisible hang.
 */
const CHAT_LOCK_WAIT_TIMEOUT_MS = 600_000

/**
 * Execute `fn` while holding an advisory lock keyed on `chatKey`.
 * Only one caller per `chatKey` can run at a time across all API instances.
 *
 * The lock is acquired by taking a dedicated connection from the pool and
 * calling `pg_advisory_lock(hashtext(chatKey))`, and released with a paired
 * `pg_advisory_unlock` before the connection returns to the pool. The
 * acquire runs inside a transaction so `SET LOCAL lock_timeout` bounds only
 * the lock wait and reverts at COMMIT (the session-level advisory lock
 * itself survives the COMMIT). Any path that leaves the session state
 * unproven destroys the connection instead of pooling it.
 */
export async function withChatLock<T>(chatKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  let acquired = false
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '${CHAT_LOCK_WAIT_TIMEOUT_MS}ms'`)
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [chatKey])
    await client.query('COMMIT')
    acquired = true
    return await fn()
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [chatKey])
        client.release()
      } catch (err) {
        // Unlock unconfirmed — destroy the connection so the session closes
        // and Postgres frees the lock, rather than pooling a session that
        // may still hold it.
        client.release(err as Error)
      }
    } else {
      // Acquire failed mid-flight (lock_timeout, connection error): the
      // session may be inside an aborted transaction and may or may not
      // hold the lock. Destroy it — a fresh connection is cheaper than a
      // poisoned pooled session.
      client.release(new Error(`withChatLock acquire failed for ${chatKey}`))
    }
  }
}
