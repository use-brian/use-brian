import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'

/**
 * Integration test for migrations 232 + 233 — workspace deletion cascades its
 * assistants and its consolidation_logs (and, transitively, all workspace
 * brain data). Requires a local PostgreSQL `Use Brian` database with both
 * migrations applied; skips silently otherwise.
 *
 * Before 232 the `assistants.workspace_id` FK was ON DELETE SET NULL, which
 * collided with the `assistants_workspace_required` NOT-NULL CHECK and aborted
 * every workspace delete. 233 fixes the second blocker 232 missed: the lone
 * direct FK to workspaces(id) that wasn't CASCADE —
 * `consolidation_logs.workspace_id` (the legacy `consolidation_logs_team_id_fkey`,
 * ON DELETE NO ACTION) — whose end-of-statement check aborted the delete for
 * any workspace that had run a team consolidation tick.
 *
 * This test exercises the exact SQL `workspaceStore.delete()` runs and asserts
 * the cascade reaches the assistant, a referencing brain-data row (a task,
 * proving the NO-ACTION `tasks.assistant_id` FK resolves because the task is
 * deleted in the same statement), and a workspace-scoped consolidation_logs
 * row (proving the migration-233 CASCADE).
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe the post-232 + post-233 FK actions; skip unless both migrations
      // are applied (every FK referencing workspaces(id) must be CASCADE).
      const r = await client.query<{ noncascade: string }>(
        `SELECT count(*)::text AS noncascade FROM pg_constraint
         WHERE contype = 'f' AND confrelid = 'workspaces'::regclass
           AND confdeltype <> 'c'`, // 'c' = CASCADE
      )
      if ((r.rows[0]?.noncascade ?? '1') !== '0') return false
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

describeIf('[COMP:api/workspace-store] workspace delete cascade (mig 232 + 233)', () => {
  it('deleting a non-personal workspace cascades its assistants, brain data, and consolidation logs', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')

      const { rows: [u] } = await client.query<{ id: string }>(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'ws-del-' || gen_random_uuid())
         RETURNING id`,
      )
      const { rows: [w] } = await client.query<{ id: string }>(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'ws-del-test', 'test', $1, false)
         RETURNING id`,
        [u.id],
      )
      const { rows: [a] } = await client.query<{ id: string }>(
        `INSERT INTO assistants (id, name, workspace_id, kind, owner_user_id)
         VALUES (gen_random_uuid(), 'ws-del-primary', $1, 'primary', $2)
         RETURNING id`,
        [w.id, u.id],
      )
      // A brain-data row whose assistant_id FK is NO ACTION — proves the
      // end-of-statement check passes because the task is cascade-deleted too.
      const { rows: [t] } = await client.query<{ id: string }>(
        `INSERT INTO tasks (id, workspace_id, title, status, assistant_id, created_by_assistant_id, user_id)
         VALUES (gen_random_uuid(), $1, 'ws-del-task', 'todo', $2, $2, $3)
         RETURNING id`,
        [w.id, a.id, u.id],
      )
      // A workspace-scoped consolidation log (user_id NULL per the mig-140
      // scope XOR). Its direct workspace_id FK was the migration-233 blocker:
      // ON DELETE NO ACTION aborted the workspace delete despite the assistant
      // cascade. Proves the post-233 CASCADE removes it.
      const { rows: [cl] } = await client.query<{ id: string }>(
        `INSERT INTO consolidation_logs (id, assistant_id, user_id, workspace_id, phase, summary)
         VALUES (gen_random_uuid(), $1, NULL, $2, 'light', 'ws-del-consolidation')
         RETURNING id`,
        [a.id, w.id],
      )

      // The exact SQL workspaceStore.delete() runs.
      const del = await client.query(
        `DELETE FROM workspaces WHERE id = $1 AND owner_user_id = $2 AND is_personal = false`,
        [w.id, u.id],
      )
      expect(del.rowCount).toBe(1)

      const wLeft = await client.query(`SELECT 1 FROM workspaces WHERE id = $1`, [w.id])
      const aLeft = await client.query(`SELECT 1 FROM assistants WHERE id = $1`, [a.id])
      const tLeft = await client.query(`SELECT 1 FROM tasks WHERE id = $1`, [t.id])
      const clLeft = await client.query(`SELECT 1 FROM consolidation_logs WHERE id = $1`, [cl.id])
      expect(wLeft.rowCount).toBe(0)
      expect(aLeft.rowCount).toBe(0) // assistant cascaded with the workspace
      expect(tLeft.rowCount).toBe(0) // brain data cascaded too
      expect(clLeft.rowCount).toBe(0) // consolidation log cascaded too (mig 233)

      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('refuses to delete a personal workspace (is_personal = true)', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const { rows: [u] } = await client.query<{ id: string }>(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'ws-del-p-' || gen_random_uuid())
         RETURNING id`,
      )
      const { rows: [w] } = await client.query<{ id: string }>(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'ws-del-personal', 'test', $1, true)
         RETURNING id`,
        [u.id],
      )
      const del = await client.query(
        `DELETE FROM workspaces WHERE id = $1 AND owner_user_id = $2 AND is_personal = false`,
        [w.id, u.id],
      )
      expect(del.rowCount).toBe(0) // guarded off — personal workspaces aren't user-deletable
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
