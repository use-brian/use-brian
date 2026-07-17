import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for createDbSessionStateStore. Requires a local PostgreSQL
 * database named `Use Brian` with migration 070 applied. Skips silently when
 * the DB is unavailable (e.g. CI without a pg service).
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM session_state LIMIT 1')
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

describeIf('[COMP:api/session-state-store] createDbSessionStateStore (integration)', () => {
  let userId: string
  let assistantId: string
  let sessionId: string
  let store: typeof import('../session-state-store.js') extends { createDbSessionStateStore: infer T }
    ? T extends () => infer R
      ? R
      : never
    : never

  beforeAll(async () => {
    // Import after we know the DB is reachable so the `pg` singleton
    // in client.ts connects to the correct database.
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../session-state-store.js')
    store = mod.createDbSessionStateStore()
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'ss-' || gen_random_uuid())
         RETURNING id`,
      ).then((r) => {
        userId = r.rows[0].id
      })

      // Post-§9: every assistant must have a workspace_id. Create a
      // throwaway Personal workspace for the test user.
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
      assistantId = asst.rows[0].id

      const sess = await client.query(
        `INSERT INTO sessions (id, assistant_id, user_id, channel_type, channel_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'web', 'web:test', 'idle')
         RETURNING id`,
        [assistantId, userId],
      )
      sessionId = sess.rows[0].id
    } finally {
      client.release()
    }
  })

  it('upsert → listOpenBySession round trip', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'pill:2026-04-23',
      summary: 'Confirm 2 PM pill',
      source: 'tool',
    })
    const open = await store.listOpenBySession(sessionId)
    expect(open).toHaveLength(1)
    expect(open[0].key).toBe('pill:2026-04-23')
    expect(open[0].status).toBe('open')
    expect(open[0].source).toBe('tool')
  })

  it('upsert twice on same key updates in place (no duplicate row)', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'first', source: 'tool',
    })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'second', source: 'tool',
    })
    const all = await store.listRecentBySession(sessionId)
    expect(all).toHaveLength(1)
    expect(all[0].summary).toBe('second')
    expect(all[0].source).toBe('tool')
  })

  // ── Provenance rule ───────────────────────────────────────
  // See docs/architecture/context-engine/session-state.md →
  // "Provenance rule on conflicting writes". The tool path is
  // authoritative over diff-pass for summary + detail.
  it('diff-pass upsert preserves tool-written detail', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'itinerary:seoul',
      summary: 'Seoul trip',
      detail: 'Day 1: Han River. Day 2: Gyeongbokgung. Day 3: Yonex. Day 4: Namsan. Day 5: Bonjuk.',
      source: 'tool',
    })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'itinerary:seoul',
      summary: 'Seoul trip (5 days)',
      detail: null, // diff-pass commonly emits no detail
      source: 'diff-pass',
    })
    const rows = await store.listRecentBySession(sessionId)
    expect(rows).toHaveLength(1)
    // Detail preserved from the tool write:
    expect(rows[0].detail).toBe(
      'Day 1: Han River. Day 2: Gyeongbokgung. Day 3: Yonex. Day 4: Namsan. Day 5: Bonjuk.',
    )
    // Summary also preserved (tool is authoritative):
    expect(rows[0].summary).toBe('Seoul trip')
    // Source reflects the most recent writer:
    expect(rows[0].source).toBe('diff-pass')
  })

  it('tool upsert overwrites diff-pass-written detail (tool is authoritative)', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'trip:day2',
      summary: 'Day 2 dinner',
      detail: 'Auto-derived by diff-pass',
      source: 'diff-pass',
    })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'trip:day2',
      summary: 'Day 2 dinner decided',
      detail: '三清洞摩西年糕鍋, 19:00',
      source: 'tool',
    })
    const rows = await store.listRecentBySession(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('Day 2 dinner decided')
    expect(rows[0].detail).toBe('三清洞摩西年糕鍋, 19:00')
    expect(rows[0].source).toBe('tool')
  })

  it('diff-pass over diff-pass writes normally (no provenance protection between peers)', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'auto:key',
      summary: 'v1',
      detail: 'detail-v1',
      source: 'diff-pass',
    })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'auto:key',
      summary: 'v2',
      detail: null,
      source: 'diff-pass',
    })
    const rows = await store.listRecentBySession(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('v2')
    expect(rows[0].detail).toBeNull()
  })

  it('resolve flips the row and sets resolved_at', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'trip:day2', summary: 'Pick dinner', source: 'tool',
    })
    const resolved = await store.resolve({ sessionId, key: 'trip:day2', source: 'tool' })
    expect(resolved).not.toBeNull()
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolvedAt).toBeInstanceOf(Date)
    expect(await store.listOpenBySession(sessionId)).toHaveLength(0)
  })

  it('resolve returns null when the key does not exist', async () => {
    const res = await store.resolve({ sessionId, key: 'phantom', source: 'tool' })
    expect(res).toBeNull()
  })

  it('re-upsert after resolve reopens the row', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'today', source: 'tool',
    })
    await store.resolve({ sessionId, key: 'pill:today', source: 'tool' })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'pill:today', summary: 'tomorrow', source: 'tool',
    })
    const open = await store.listOpenBySession(sessionId)
    expect(open).toHaveLength(1)
    expect(open[0].summary).toBe('tomorrow')
    expect(open[0].resolvedAt).toBeNull()
  })

  it('purgeResolvedOlderThan removes old resolved rows only', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'old', summary: 'old', source: 'tool',
    })
    await store.resolve({ sessionId, key: 'old', source: 'tool' })
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'current', summary: 'current', source: 'tool',
    })

    // Backdate the resolved row
    const client = await pool!.connect()
    try {
      await client.query(
        `UPDATE session_state SET resolved_at = now() - interval '48 hours' WHERE key = 'old' AND session_id = $1`,
        [sessionId],
      )
    } finally {
      client.release()
    }

    const deletedCount = await store.purgeResolvedOlderThan(
      sessionId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    )
    expect(deletedCount).toBe(1)

    const remaining = await store.listRecentBySession(sessionId)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].key).toBe('current')
  })

  it('cascades on session delete', async () => {
    await store.upsert({
      sessionId, userId, assistantId,
      key: 'cascade:test', summary: 'x', source: 'tool',
    })
    const client = await pool!.connect()
    try {
      await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId])
      const r = await client.query(
        `SELECT id FROM session_state WHERE session_id = $1`,
        [sessionId],
      )
      expect(r.rows).toHaveLength(0)
    } finally {
      client.release()
    }
  })
})
