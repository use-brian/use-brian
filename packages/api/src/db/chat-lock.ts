/**
 * Postgres advisory lock for per-chat message sequentialization.
 *
 * Replaces in-memory `chatLocks` Maps in channel routes. Advisory locks
 * survive API restarts and work across multiple API instances (all share
 * the same Cloud SQL database).
 *
 * Uses session-level advisory locks: the lock is held for the duration
 * of the DB connection and auto-releases when the connection returns to
 * the pool. This guarantees cleanup even on crashes.
 */

import { getPool } from './client.js'

/**
 * Execute `fn` while holding an advisory lock keyed on `chatKey`.
 * Only one caller per `chatKey` can run at a time across all API instances.
 *
 * The lock is acquired by taking a dedicated connection from the pool
 * and calling `pg_advisory_lock(hashtext(chatKey))`. The connection
 * (and thus the lock) is released in the finally block.
 */
export async function withChatLock<T>(chatKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    // hashtext() converts arbitrary text to a 32-bit int suitable for advisory locks
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [chatKey])
    return await fn()
  } finally {
    // Releasing the connection auto-releases the session-level advisory lock
    client.release()
  }
}
