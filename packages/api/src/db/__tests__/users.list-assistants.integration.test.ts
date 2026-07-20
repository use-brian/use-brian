import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

/**
 * [COMP:api/assistants-list] listAccessibleAssistants — integration test.
 *
 * Exercises real Postgres so the LEFT-JOIN dedup and effective-role
 * precedence run end-to-end. This is the behavioural proof for the phantom
 * "duplicate assistant" regression: a user reachable through both a direct
 * `assistant_members` grant AND `workspace_members` — with *different* roles
 * in each — must appear exactly once, carrying the higher-privilege role.
 *
 * Requires a local PostgreSQL database named `Use Brian`. Skips silently
 * when the DB is unavailable. See docs/workflow/testing.md.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM assistants LIMIT 1')
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

// The function under test reaches Postgres through the shared `getPool()`
// (reads DATABASE_URL, defaulted to postgres:///sidanclaw by the
// integration vitest config) — the same `Use Brian` DB this suite's own
// pool fixtures write to.
const { listAccessibleAssistants } = await import('../users.js')

describeIf('[COMP:api/assistants-list] listAccessibleAssistants (integration)', () => {
  const ids = { owner: '', member: '', workspace: '', assistant: '' }

  async function makeUser(client: pg.PoolClient, label: string): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO users (id, auth_provider, auth_provider_id)
       VALUES (gen_random_uuid(), 'test', $1 || '-' || gen_random_uuid())
       RETURNING id`,
      [label],
    )
    return r.rows[0].id
  }

  beforeAll(async () => {
    const client = await pool!.connect()
    try {
      ids.owner = await makeUser(client, 'list-owner')
      ids.member = await makeUser(client, 'list-member')

      const ws = await client.query<{ id: string }>(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'list-test-ws', 'test', $1, false)
         RETURNING id`,
        [ids.owner],
      )
      ids.workspace = ws.rows[0].id

      const a = await client.query<{ id: string }>(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind)
         VALUES (gen_random_uuid(), 'list-test-primary', NULL, $1, 'primary')
         RETURNING id`,
        [ids.workspace],
      )
      ids.assistant = a.rows[0].id

      // The second user is given DIFFERENT roles in the two membership
      // tables for the SAME assistant — the exact shape that produced two
      // rows under the old UNION.
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'admin')`,
        [ids.workspace, ids.owner, ids.member],
      )
      await client.query(
        `INSERT INTO assistant_members (assistant_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [ids.assistant, ids.owner, ids.member],
      )
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!pool) return
    const client = await pool.connect()
    try {
      // Delete in dependency order. Deleting the owner *first* would cascade
      // the workspace, whose deletion SET-NULLs the assistant's workspace_id
      // and trips the `assistants_workspace_required` CHECK. Removing the
      // assistant and workspace up front (each cascades its membership rows)
      // avoids that path; the users then delete cleanly.
      await client.query(`DELETE FROM assistants WHERE id = $1`, [ids.assistant])
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [ids.workspace])
      await client.query(`DELETE FROM users WHERE id = ANY($1)`, [[ids.owner, ids.member]])
    } finally {
      client.release()
    }
    await pool.end()
  })

  it('lists the assistant exactly once for a user with mismatched direct/workspace roles', async () => {
    const rows = await listAccessibleAssistants(ids.member, ids.workspace)
    expect(rows.filter((r) => r.id === ids.assistant)).toHaveLength(1)
  })

  it('reports the higher-privilege effective role (admin beats member)', async () => {
    const rows = await listAccessibleAssistants(ids.member, ids.workspace)
    // workspace_members.role='admin' wins over assistant_members.role='member'.
    expect(rows.find((r) => r.id === ids.assistant)?.role).toBe('admin')
  })

  it('reports owner for the workspace owner, also exactly once', async () => {
    const rows = await listAccessibleAssistants(ids.owner, ids.workspace)
    const forAssistant = rows.filter((r) => r.id === ids.assistant)
    expect(forAssistant).toHaveLength(1)
    expect(forAssistant[0].role).toBe('owner')
  })
})
