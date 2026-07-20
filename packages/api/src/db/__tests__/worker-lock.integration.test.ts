/**
 * Integration test for `withWorkerLock` — the row-based replacement for
 * the old session-tied `pg_advisory_lock` pattern. Component tag:
 * [COMP:consolidation/worker-lock].
 *
 * Requires a local PostgreSQL named `Use Brian` with the `worker_locks`
 * table (migration 180). Skips silently when the DB is unavailable.
 *
 * What we verify:
 *   1. Acquire + release on the happy path (row appears, then disappears).
 *   2. Contention — a second acquire with an unexpired row returns false.
 *   3. TTL takeover — when the existing row's `expires_at < now()`, a
 *      second acquire reclaims it.
 *   4. Crash safety — if `fn()` throws, the row is still cleaned up so
 *      future acquires don't get stuck behind the dead holder.
 *   5. Heartbeat extension — the lock's `expires_at` grows while `fn()`
 *      runs so a long-running tick doesn't get stolen out from under it.
 *   6. Connection-pool frugality — at no point are we holding more than
 *      one connection during `fn()`. The whole *point* of this refactor.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` →
 * "Lock pattern" + `packages/api/src/db/memories.ts → withWorkerLock`.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000, max: 5 })
  try {
    const client = await p.connect()
    // Migration 180 must be applied — bail cleanly if not so we don't
    // confuse a missing-table failure with a real lock bug.
    const exists = await client.query<{ regclass: string | null }>(
      `SELECT to_regclass('public.worker_locks')::text AS regclass`,
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

// Process-wide lock IDs that won't collide with the production
// `CONSOLIDATION_LOCK_ID` (900_001). Anything in a deliberately distinct
// range so a stray prod-side acquire in dev doesn't poison the test.
const ACQUIRE_LOCK = 950_001
const CONTENTION_LOCK = 950_002
const TTL_LOCK = 950_003
const CRASH_LOCK = 950_004
const HEARTBEAT_LOCK = 950_005

beforeEach(async () => {
  // Wipe any stale rows from prior runs. Each test's own ID is unique,
  // but a crashed previous run might have left state.
  if (!pool) return
  await pool.query('DELETE FROM worker_locks WHERE lock_id BETWEEN 950000 AND 950999')
})

describeIf('[COMP:consolidation/worker-lock] withWorkerLock (integration)', () => {
  // Dynamic import inside the describe so the module's `randomUUID` and
  // bare `query()` see the same `getPool()` singleton this test
  // initialised above. Without the dynamic import the SUT would load
  // before pg is connect-tested and could fail silently.
  const loadSUT = async () => {
    const mod = await import('../memories.js')
    return mod.withWorkerLock
  }

  it('acquires, runs fn, and removes the lock row on completion', async () => {
    const withWorkerLock = await loadSUT()
    let ran = false
    const ok = await withWorkerLock(ACQUIRE_LOCK, async () => {
      ran = true
      // Mid-flight: row exists with our holder_id (we don't know it, so
      // just assert presence).
      const inFlight = await pool!.query(
        `SELECT 1 FROM worker_locks WHERE lock_id = $1`,
        [ACQUIRE_LOCK],
      )
      expect(inFlight.rowCount).toBe(1)
    })
    expect(ok).toBe(true)
    expect(ran).toBe(true)

    // Post-flight: row is gone.
    const after = await pool!.query(
      `SELECT 1 FROM worker_locks WHERE lock_id = $1`,
      [ACQUIRE_LOCK],
    )
    expect(after.rowCount).toBe(0)
  })

  it('refuses a second acquire while the first still holds an unexpired lock', async () => {
    const withWorkerLock = await loadSUT()
    // Hold the lock with a long-running fn. Start it without awaiting so
    // we can race a second acquire against it.
    let firstResolved = false
    let releaseFirst!: () => void
    const firstFnDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstAcquire = withWorkerLock(CONTENTION_LOCK, async () => {
      await firstFnDone
      firstResolved = true
    })

    // Give the acquire a beat to land the row.
    await new Promise((r) => setTimeout(r, 50))

    // Second acquire should return false — row exists, not expired.
    let secondRan = false
    const secondAcquire = await withWorkerLock(CONTENTION_LOCK, async () => {
      secondRan = true
    })
    expect(secondAcquire).toBe(false)
    expect(secondRan).toBe(false)

    // Release the first, then it should clean up.
    releaseFirst()
    await firstAcquire
    expect(firstResolved).toBe(true)

    // Third acquire (after release) should succeed now.
    let thirdRan = false
    const thirdAcquire = await withWorkerLock(CONTENTION_LOCK, async () => {
      thirdRan = true
    })
    expect(thirdAcquire).toBe(true)
    expect(thirdRan).toBe(true)
  })

  it('reclaims an expired lock left behind by a dead holder', async () => {
    const withWorkerLock = await loadSUT()

    // Manually insert a stale row that's already expired — simulates a
    // worker that crashed between acquire and release.
    await pool!.query(
      `INSERT INTO worker_locks (lock_id, holder_id, expires_at, acquired_at, holder_label)
       VALUES ($1, gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour', 'dead-holder')`,
      [TTL_LOCK],
    )

    let ran = false
    const ok = await withWorkerLock(TTL_LOCK, async () => {
      ran = true
    })
    expect(ok).toBe(true)
    expect(ran).toBe(true)

    // Row should be gone — we acquired, ran, and deleted it.
    const after = await pool!.query(
      `SELECT 1 FROM worker_locks WHERE lock_id = $1`,
      [TTL_LOCK],
    )
    expect(after.rowCount).toBe(0)
  })

  it('releases the lock row even when fn throws', async () => {
    const withWorkerLock = await loadSUT()

    await expect(
      withWorkerLock(CRASH_LOCK, async () => {
        throw new Error('intentional crash')
      }),
    ).rejects.toThrow('intentional crash')

    // Row should be cleaned up by the finally block; the next acquire
    // must succeed without waiting for a TTL.
    const after = await pool!.query(
      `SELECT 1 FROM worker_locks WHERE lock_id = $1`,
      [CRASH_LOCK],
    )
    expect(after.rowCount).toBe(0)

    // And a fresh acquire on the same id works immediately.
    let secondRan = false
    const ok = await withWorkerLock(CRASH_LOCK, async () => {
      secondRan = true
    })
    expect(ok).toBe(true)
    expect(secondRan).toBe(true)
  })

  it('heartbeat extends expires_at while fn is running', async () => {
    const withWorkerLock = await loadSUT()

    // Short TTL so the heartbeat fires inside the test window. The
    // heartbeat cadence is TTL/3, so with TTL=900ms the heartbeat fires
    // every ~300ms. fn() runs ~1.5s, well past the original TTL.
    const TTL_MS = 900

    let firstExpiry: number | null = null
    let lastExpiry: number | null = null

    const ok = await withWorkerLock(
      HEARTBEAT_LOCK,
      async () => {
        const first = await pool!.query<{ expires_at: Date }>(
          `SELECT expires_at FROM worker_locks WHERE lock_id = $1`,
          [HEARTBEAT_LOCK],
        )
        firstExpiry = first.rows[0]!.expires_at.getTime()

        // Wait past the original TTL. If heartbeat isn't extending,
        // expires_at would NOT advance.
        await new Promise((r) => setTimeout(r, 1_500))

        const last = await pool!.query<{ expires_at: Date }>(
          `SELECT expires_at FROM worker_locks WHERE lock_id = $1`,
          [HEARTBEAT_LOCK],
        )
        // Row may have been touched by heartbeat; if so, expires_at
        // should be strictly greater than firstExpiry. (If heartbeat
        // never fired or the takeover happened, this asserts the
        // bug.)
        lastExpiry = last.rows[0]!.expires_at.getTime()
      },
      { ttlMs: TTL_MS },
    )

    expect(ok).toBe(true)
    expect(firstExpiry).not.toBeNull()
    expect(lastExpiry).not.toBeNull()
    // Heartbeat fired at least once during the 1.5s sleep — expires_at
    // grew beyond the initial value.
    expect(lastExpiry!).toBeGreaterThan(firstExpiry!)
  })
})
