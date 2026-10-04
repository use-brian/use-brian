import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * [COMP:api/merge-shadow] against a migration-replayed database.
 *
 * Historical evidence references users ON DELETE RESTRICT on purpose
 * (session_messages.user_id = who spoke, scope_derivations.user_id = whose
 * authority produced a resource). A shadow named by such a row cannot be
 * deleted, so the merge must RETIRE it - move the user-visible data, keep
 * the row as the historical author, and take it out of every lookup - rather
 * than roll the whole link back. A shadow nothing names is still deleted.
 *
 * Env-gated: set MERGE_SHADOW_TEST_DATABASE_URL to a migrated database whose
 * role owns the schema. Commits for real (mergeShadowUser runs its own
 * transaction), so every row it creates is removed in afterAll.
 */
const connectionString = process.env.MERGE_SHADOW_TEST_DATABASE_URL
const describeIf = connectionString ? describe : describe.skip

describeIf('[COMP:api/merge-shadow] mergeShadowUser integration', () => {
  let pool: pg.Pool
  let mergeShadowUser: typeof import('../linked-accounts.js').mergeShadowUser
  const users: string[] = []
  const sessions: string[] = []
  let workspace: string
  let assistant: string

  async function insertUser(provider: string, providerId: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id) VALUES ($1, $2) RETURNING id`,
      [provider, providerId],
    )).rows[0].id
    users.push(id)
    return id
  }

  async function insertSession(userId: string, channelId: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id)
       VALUES ($1, $2, 'feishu', $3) RETURNING id`,
      [assistant, userId, channelId],
    )).rows[0].id
    sessions.push(id)
    return id
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString
    pool = new pg.Pool({ connectionString })
    ;({ mergeShadowUser } = await import('../linked-accounts.js'))
    const owner = await insertUser('test', `merge-owner-${randomUUID()}`)
    workspace = (await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ('Merge test', 'test', $1, false) RETURNING id`,
      [owner],
    )).rows[0].id
    assistant = (await pool.query<{ id: string }>(
      `INSERT INTO assistants (name, owner_user_id, workspace_id)
       VALUES ('Merge test assistant', $1, $2) RETURNING id`,
      [owner, workspace],
    )).rows[0].id
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query('DELETE FROM session_messages WHERE session_id = ANY($1)', [sessions])
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [sessions])
    await pool.query('DELETE FROM assistant_members WHERE user_id = ANY($1)', [users])
    await pool.query('DELETE FROM linked_identities WHERE user_id = ANY($1)', [users])
    await pool.query('DELETE FROM user_merges WHERE target_user_id = ANY($1)', [users])
    await pool.query('DELETE FROM assistants WHERE id = $1', [assistant])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspace])
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users])
    await pool.end()
    const { getPool } = await import('../client.js')
    await getPool().end()
  })

  it('retires a shadow that authored messages instead of rolling the link back', async () => {
    const openId = `ou_${randomUUID().replaceAll('-', '')}`
    const real = await insertUser('test', `merge-real-${randomUUID()}`)
    const shadow = await insertUser('channel', `feishu:${openId}`)
    const shadowEmail = `shadow-${randomUUID()}@example.com`
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [shadowEmail, shadow])
    await pool.query(
      `INSERT INTO assistant_members (assistant_id, user_id) VALUES ($1, $2)`,
      [assistant, shadow],
    )
    const session = await insertSession(shadow, `oc_${randomUUID()}`)
    await pool.query(
      `INSERT INTO session_messages
         (session_id, role, content, sequence_num, user_id, workspace_id, assistant_id,
          sensitivity, compartments, project_ids, scope_version, scope_held)
       VALUES ($1, 'user', '"hello"'::jsonb, 1, $2, $3, $4, 'public', '{}', '{}', 1, false)`,
      [session, shadow, workspace, assistant],
    )

    const result = await mergeShadowUser(real, openId, 'feishu', { reason: 'link-code' })
    expect(result).toEqual({ merged: true, shadowUserId: shadow })

    const moved = await pool.query('SELECT user_id FROM sessions WHERE id = $1', [session])
    expect(moved.rows[0].user_id).toBe(real)
    const author = await pool.query('SELECT user_id FROM session_messages WHERE session_id = $1', [session])
    expect(author.rows[0].user_id).toBe(shadow)
    const retired = await pool.query(
      'SELECT auth_provider, auth_provider_id FROM users WHERE id = $1',
      [shadow],
    )
    expect(retired.rows[0]).toEqual({ auth_provider: 'merged', auth_provider_id: `merged:${shadow}` })
    // Unreachable by email (sign-in / matching) and holding no live seat.
    const byEmail = await pool.query('SELECT id FROM users WHERE email = $1', [shadowEmail])
    expect(byEmail.rowCount).toBe(0)
    const seat = await pool.query('SELECT 1 FROM assistant_members WHERE user_id = $1', [shadow])
    expect(seat.rowCount).toBe(0)
    const link = await pool.query(
      `SELECT user_id FROM linked_identities WHERE provider = 'feishu' AND provider_id = $1`,
      [openId],
    )
    expect(link.rows[0].user_id).toBe(real)

    // Idempotent: the retired row is invisible to the shadow lookup.
    expect(await mergeShadowUser(real, openId, 'feishu')).toEqual({ merged: false })
  })

  it('still deletes a shadow that nothing historical references', async () => {
    const openId = `ou_${randomUUID().replaceAll('-', '')}`
    const real = await insertUser('test', `merge-real-${randomUUID()}`)
    const shadow = await insertUser('channel', `feishu:${openId}`)
    const session = await insertSession(shadow, `oc_${randomUUID()}`)

    expect(await mergeShadowUser(real, openId, 'feishu')).toEqual({ merged: true, shadowUserId: shadow })

    const gone = await pool.query('SELECT 1 FROM users WHERE id = $1', [shadow])
    expect(gone.rowCount).toBe(0)
    const moved = await pool.query('SELECT user_id FROM sessions WHERE id = $1', [session])
    expect(moved.rows[0].user_id).toBe(real)
  })
})
