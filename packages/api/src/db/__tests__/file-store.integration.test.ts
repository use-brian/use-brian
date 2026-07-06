import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for the file_cache reaper (`createDbFileStore().sweepExpired`).
 * Requires a local PostgreSQL database named `sidanclaw` with the open schema
 * applied. Skips silently when the DB is unavailable (e.g. CI without a pg
 * service).
 *
 * See docs/architecture/brain/file-artifacts.md → "file_cache reaper".
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM file_cache LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

describeIf('[COMP:files/file-cache-reaper] createDbFileStore().sweepExpired (integration)', () => {
  let sessionId: string
  let store: typeof import('../file-store.js') extends { createDbFileStore: infer T }
    ? T extends () => infer R
      ? R
      : never
    : never

  beforeAll(async () => {
    // Import after we know the DB is reachable so the `pg` singleton in
    // client.ts connects to the correct database.
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../file-store.js')
    store = mod.createDbFileStore()
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      const usr = await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'fc-' || gen_random_uuid())
         RETURNING id`,
      )
      const userId = usr.rows[0].id

      const ws = await client.query(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'test-ws', 'test', $1, true)
         RETURNING id`,
        [userId],
      )
      const workspaceId = ws.rows[0].id

      const asst = await client.query(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
         VALUES (gen_random_uuid(), 'test-assistant', $1, $2)
         RETURNING id`,
        [userId, workspaceId],
      )
      const assistantId = asst.rows[0].id

      const sess = await client.query(
        `INSERT INTO sessions (id, assistant_id, user_id, channel_type, channel_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'web', 'web:fc-test', 'idle')
         RETURNING id`,
        [assistantId, userId],
      )
      sessionId = sess.rows[0].id

      // Clear any pre-existing expired rows so the returned count is exactly
      // what this test inserts. file_cache is touched by no other suite.
      await client.query(`DELETE FROM file_cache WHERE expires_at <= now()`)
    } finally {
      client.release()
    }
  })

  it('deletes expired rows, retains unexpired, and returns the count', async () => {
    // Negative expiryDays lands `expires_at` in the past → already expired.
    const expired = await store.cache({
      sessionId, fileName: 'stale.txt', mimeType: 'text/plain',
      content: 'gone', sizeBytes: 4, expiryDays: -1,
    })
    const live = await store.cache({
      sessionId, fileName: 'fresh.txt', mimeType: 'text/plain',
      content: 'kept', sizeBytes: 4, expiryDays: 7,
    })

    const deleted = await store.sweepExpired!()
    expect(deleted).toBe(1)

    // Assert against the raw table — store.get() filters `expires_at > now()`
    // so it hides an expired row whether or not the DELETE fired.
    const client = await pool!.connect()
    try {
      const gone = await client.query(`SELECT 1 FROM file_cache WHERE id = $1`, [expired.id])
      expect(gone.rowCount).toBe(0)
      const kept = await client.query(`SELECT 1 FROM file_cache WHERE id = $1`, [live.id])
      expect(kept.rowCount).toBe(1)
    } finally {
      client.release()
    }

    // Nothing expired remains → a second sweep is a no-op.
    expect(await store.sweepExpired!()).toBe(0)
  })
})
