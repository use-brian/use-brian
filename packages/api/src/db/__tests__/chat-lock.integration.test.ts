/**
 * Integration test for `withChatLock` — per-chat sequentialization via a
 * Postgres session-level advisory lock. Component tag:
 * [COMP:channels/chat-lock].
 *
 * Requires a local PostgreSQL named `sidanclaw`. Skips silently when the
 * DB is unavailable.
 *
 * What we verify:
 *   1. Happy path — while `fn()` runs the lock is held (another session's
 *      `pg_try_advisory_lock` fails); after resolution it is RELEASED
 *      (another session's `pg_try_advisory_lock` succeeds immediately).
 *      This is the regression proof for the 2026-07-14 GM Bro incident:
 *      the old implementation returned the connection to the pool without
 *      unlocking, so the session kept the lock and the next message for
 *      the same chat blocked forever with no error and no log.
 *   2. Crash safety — if `fn()` throws, the lock is still released.
 *   3. Serialization — two concurrent `withChatLock` calls on the same key
 *      never overlap their `fn()` executions.
 *
 * Spec: `docs/architecture/channels/adapter-pattern.md` → "Per-Chat
 * Sequentialization".
 */

import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'

process.env.DATABASE_URL ??= 'postgres:///sidanclaw'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000, max: 2 })
  try {
    const client = await p.connect()
    client.release()
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

/**
 * Probe from an INDEPENDENT session: can the lock for `chatKey` be taken
 * right now? Uses a dedicated connection so the probe never shares the
 * SUT's session (session-level advisory locks are re-entrant within one
 * session, which would make a shared-session probe always succeed).
 */
async function lockIsFree(chatKey: string): Promise<boolean> {
  const client = await pool!.connect()
  try {
    const res = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [chatKey],
    )
    if (res.rows[0].ok) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [chatKey])
      return true
    }
    return false
  } finally {
    client.release()
  }
}

describeIf('[COMP:channels/chat-lock] withChatLock (integration)', () => {
  // Dynamic import so the SUT's `getPool()` singleton initialises after the
  // connect-test above (same pattern as worker-lock.integration.test.ts).
  const loadSUT = async () => {
    const mod = await import('../chat-lock.js')
    return mod.withChatLock
  }

  it('holds the lock while fn runs and releases it on resolution', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:happy'

    let heldDuringFn: boolean | undefined
    await withChatLock(key, async () => {
      heldDuringFn = !(await lockIsFree(key))
    })

    expect(heldDuringFn).toBe(true)
    // Regression proof: the pooled connection must NOT still hold the lock.
    expect(await lockIsFree(key)).toBe(true)
  })

  it('releases the lock when fn throws', async () => {
    const withChatLock = await loadSUT()
    const key = 'test-chat-lock:crash'

    await expect(
      withChatLock(key, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await lockIsFree(key)).toBe(true)
  })

  it('serializes concurrent callers on the same key', async () => {
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
    expect(await lockIsFree(key)).toBe(true)
  })
})
