import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for createDbPlanStore. Requires a local PostgreSQL
 * database named `Use Brian` with migration 272 applied. Skips silently when
 * the DB is unavailable (e.g. CI without a pg service).
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM plan_steps LIMIT 1')
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

const ATT = '11111111-1111-1111-1111-111111111111'

describeIf('[COMP:api/plan-steps-store] createDbPlanStore (integration)', () => {
  let userId: string
  let assistantId: string
  let sessionId: string
  let store: ReturnType<typeof import('../plan-steps-store.js')['createDbPlanStore']>

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../plan-steps-store.js')
    store = mod.createDbPlanStore()
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      const u = await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'plan-' || gen_random_uuid()) RETURNING id`,
      )
      userId = u.rows[0].id
      const ws = await client.query(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'test-ws', 'test', $1, true) RETURNING id`,
        [userId],
      )
      const asst = await client.query(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
         VALUES (gen_random_uuid(), 'test-assistant', $1, $2) RETURNING id`,
        [userId, ws.rows[0].id],
      )
      assistantId = asst.rows[0].id
      const sess = await client.query(
        `INSERT INTO sessions (id, assistant_id, user_id, channel_type, channel_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'web', 'web:test', 'idle') RETURNING id`,
        [assistantId, userId],
      )
      sessionId = sess.rows[0].id
    } finally {
      client.release()
    }
  })

  it('upsertStep inserts as pending and lists under the active attempt', async () => {
    await store.upsertStep({
      sessionId, userId, assistantId, attemptId: ATT,
      key: 'step:a', description: 'A', position: 0, source: 'tool',
    })
    const active = await store.listActiveBySession(sessionId)
    expect(active).toHaveLength(1)
    expect(active[0].status).toBe('pending')
    expect(await store.activeAttemptId(sessionId)).toBe(ATT)
  })

  it('re-upsert preserves status (no reset on revision)', async () => {
    await store.upsertStep({
      sessionId, userId, assistantId, attemptId: ATT,
      key: 'step:a', description: 'A', position: 0, source: 'tool',
    })
    await store.updateStepStatus({ attemptId: ATT, key: 'step:a', status: 'done', note: 'ok' })
    await store.upsertStep({
      sessionId, userId, assistantId, attemptId: ATT,
      key: 'step:a', description: 'A revised', position: 0, source: 'tool',
    })
    const [row] = await store.listByAttempt(ATT)
    expect(row.status).toBe('done') // preserved
    expect(row.description).toBe('A revised') // updated
  })

  it('lifecycle: active → dormant hides from listActive; reactivation restores', async () => {
    await store.upsertStep({
      sessionId, userId, assistantId, attemptId: ATT,
      key: 'step:a', description: 'A', position: 0, source: 'tool',
    })
    await store.setAttemptState({ sessionId, attemptId: ATT, state: 'dormant' })
    expect(await store.listActiveBySession(sessionId)).toHaveLength(0)
    expect(await store.activeAttemptId(sessionId)).toBeNull()
    expect(await store.recentDormantAttemptId(sessionId)).toBe(ATT)
    await store.setAttemptState({ sessionId, attemptId: ATT, state: 'active' })
    expect(await store.listActiveBySession(sessionId)).toHaveLength(1)
  })
})
