/**
 * Integration test for `withChatLock` — per-chat sequentialization via a
 * `chat_turn_locks` lease row (migration 325). Component tag:
 * [COMP:channels/chat-lock].
 *
 * Requires a local PostgreSQL named `Use Brian` with the `chat_turn_locks`
 * table. Skips silently when the DB is unavailable.
 *
 * What we verify:
 *   1. Happy path — while `fn()` runs the lease row exists; after resolution
 *      it is gone (regression proof for the 2026-07-14 GM Bro leak, where
 *      the old advisory lock survived `fn()` and blocked the chat forever).
 *   2. Crash safety — if `fn()` throws, the lease is still released.
 *   3. Serialization — two concurrent `withChatLock` calls on the same key
 *      never overlap their `fn()` executions, in arrival order.
 *   4. Pool frugality — `fn()` can run its own queries even when the SUT's
 *      pool has a SINGLE connection. This is the regression proof for the
 *      2026-07-14 Terry AI incident: the old advisory lock pinned a pool
 *      connection for the whole turn, so with `PG_POOL_MAX=2` two concurrent
 *      turns starved every checkout and the turn's first query died with
 *      "timeout exceeded when trying to connect".
 *   5. Cross-instance contention — an unexpired foreign lease blocks the
 *      acquire until the wait bound (loud error), and an EXPIRED foreign
 *      lease is taken over immediately.
 *
 * Spec: `docs/architecture/channels/adapter-pattern.md` → "Per-Chat
 * Sequentialization".
 */

import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'

process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
// Test 4's whole point: the SUT must work when its pool has ONE connection.
// Must be set before the dynamic import below first loads client.js.
process.env.PG_POOL_MAX = '1'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000, max: 2 })
  try {
    const client = await p.connect()
    // Migration 325 must be applied — bail cleanly if not so we don't
    // confuse a missing-table failure with a real lock bug.
    const exists = await client.query<{ regclass: string | null }>(
      `SELECT to_regclass('public.chat_turn_locks')::text AS regclass`,
    )
    client.release()
    if (!exists.rows[0]?.regclass) {
      await p.end()
      return false
    }
    pool = p
    return true
  } catch {
    await p.end()
    return false
  }
}

const describeIf = (await canConnect()) ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

/** Probe from an independent connection: does an unexpired lease row exist? */
async function leaseHeld(chatKey: string): Promise<boolean> {
  const res = await pool!.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM chat_turn_locks WHERE chat_key = $1 AND expires_at > now()
     ) AS held`,
    [chatKey],
  )
  return res.rows[0].held
}

/** Plant a foreign holder's lease row directly (simulates another instance). */
async function plantForeignLease(chatKey: string, ttlMs: number): Promise<void> {
  await pool!.query(
    `INSERT INTO chat_turn_locks (chat_key, holder_id, expires_at, acquired_at)
     VALUES ($1, $2::uuid, now() + ($3 || ' milliseconds')::interval, now())
     ON CONFLICT (chat_key) DO UPDATE
       SET holder_id = EXCLUDED.holder_id, expires_at = EXCLUDED.expires_at`,
    [chatKey, randomUUID(), String(ttlMs)],
  )
}

describeIf('[COMP:channels/chat-lock] withChatLock (integration)', () => {
  // Dynamic import so the SUT's pool singleton initialises after the
  // connect-test and env setup above (same pattern as
  // worker-lock.integration.test.ts).
  const loadSUT = async () => {
    const mod = await import('../chat-lock.js')
    return mod.withChatLock
  }

  it('holds the lease while fn runs and releases it on resolution', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:happy'

    let heldDuringFn: boolean | undefined
    await withChatLock(key, async () => {
      heldDuringFn = await leaseHeld(key)
    })

    expect(heldDuringFn).toBe(true)
    // Regression proof (GM Bro): the lease must NOT survive fn().
    expect(await leaseHeld(key)).toBe(false)
  })

  it('releases the lease when fn throws', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:crash'

    await expect(
      withChatLock(key, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await leaseHeld(key)).toBe(false)
  })

  it('serializes concurrent callers on the same key in arrival order', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:serial'
    const events: string[] = []

    const first = withChatLock(key, async () => {
      events.push('first:start')
      await new Promise((r) => setTimeout(r, 150))
      events.push('first:end')
    })
    // Give the first caller time to acquire before the second queues.
    await new Promise((r) => setTimeout(r, 50))
    const second = withChatLock(key, async () => {
      events.push('second:start')
    })

    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    expect(await leaseHeld(key)).toBe(false)
  })

  it('does not consume a pool connection while fn runs (Terry AI regression)', async () => {
    const withChatLock = await loadSUT()
    // The SUT's pool is PG_POOL_MAX=1 (set at file top). Under the old
    // advisory-lock design the lock checkout pinned that single connection,
    // so this inner query could never run and died after 8s. Under the
    // lease design the pool is free while fn runs.
    const { query } = await import('../client.js')
    const key = 'test-chat-lock:frugal'

    const result = await withChatLock(key, async () => {
      const res = await query<{ ok: number }>('SELECT 1 AS ok')
      return res.rows[0].ok
    })
    expect(result).toBe(1)

    // Two concurrent turns on DIFFERENT keys must also both complete — the
    // production failure shape was concurrent turns starving each other.
    const [a, b] = await Promise.all([
      withChatLock('test-chat-lock:frugal-a', async () => {
        const res = await query<{ ok: number }>('SELECT 2 AS ok')
        return res.rows[0].ok
      }),
      withChatLock('test-chat-lock:frugal-b', async () => {
        const res = await query<{ ok: number }>('SELECT 3 AS ok')
        return res.rows[0].ok
      }),
    ])
    expect(a).toBe(2)
    expect(b).toBe(3)
  })

  it('waits behind a live foreign lease and errors loudly at the bound', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:foreign-live'
    await plantForeignLease(key, 60_000)
    try {
      await expect(
        withChatLock(key, async () => 'ran', { waitTimeoutMs: 700, pollMs: 100 }),
      ).rejects.toThrow(/timed out waiting for the chat turn lease/)
    } finally {
      await pool!.query(`DELETE FROM chat_turn_locks WHERE chat_key = $1`, [key])
    }
  })

  it('takes over an expired foreign lease (crashed holder recovery)', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:foreign-dead'
    await plantForeignLease(key, -1_000) // already expired

    const result = await withChatLock(key, async () => 'recovered', {
      waitTimeoutMs: 2_000,
      pollMs: 100,
    })
    expect(result).toBe('recovered')
    expect(await leaseHeld(key)).toBe(false)
  })
})
