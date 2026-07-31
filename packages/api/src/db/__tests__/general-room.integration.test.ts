import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

/**
 * [COMP:api/room-mechanics] — General room provisioning (multiplayer chat
 * T6/D4) against a real database.
 *
 * Two halves:
 *   1. `createWorkspaceStore().create()` provisions the default "General"
 *      workspace-shared chat session inside the create transaction.
 *   2. Migration 388's backfill INSERT is idempotent — run twice over the
 *      same room-less workspace it inserts exactly one room, and it skips a
 *      workspace that already has any shared chat room (which is also what
 *      makes a deleted General stay deleted — T12).
 *
 * The backfill half runs the migration file's INSERT inside a rolled-back
 * transaction so the suite never mutates other local workspaces (applying
 * the real migration is `pnpm --filter @use-brian/api migrate`'s job).
 *
 * Requires the local `Use Brian` PostgreSQL database; skips silently when
 * unavailable. Probes through client.js's `query` — the pool the store under
 * test resolves (DATABASE_URL), so the guard can't diverge from the code.
 */

import { query } from '../client.js'
import { createWorkspaceStore } from '../workspace-store.js'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM sessions LIMIT 1')
  } catch {
    return false
  }
  pool = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  return true
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip
if (!ok) {
  console.log('[general-room integration] skipped — sessions schema not reachable via the store DB (DATABASE_URL).')
}

afterAll(async () => {
  if (pool) await pool.end()
})

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations/388_general_room_backfill.sql',
)

/** The migration's statements without its own BEGIN/COMMIT, so the test can
 *  run them inside a rolled-back transaction. */
function backfillSql(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
    .replace(/^BEGIN;$/m, '')
    .replace(/^COMMIT;$/m, '')
}

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (auth_provider, auth_provider_id)
     VALUES ('test', 'general-room-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

describeIf('[COMP:api/room-mechanics] General room provisioning (T6/D4)', () => {
  it('workspace create provisions the General room in the same transaction', async () => {
    const client = await pool!.connect()
    let userId: string | undefined
    let workspaceId: string | undefined
    try {
      userId = await makeUser(client)
      const store = createWorkspaceStore()
      const ws = await store.create(userId, 'Room Test WS', 'general-room integration fixture')
      workspaceId = ws.id

      const rooms = await client.query(
        `SELECT s.title, s.visibility, s.channel_type, s.app_origin,
                s.title_manually_set, s.effective_clearance, s.user_id,
                a.clearance AS assistant_clearance, a.kind
           FROM sessions s
           JOIN assistants a ON a.id = s.assistant_id
          WHERE s.workspace_id = $1
            AND s.visibility = 'workspace'
            AND s.channel_type = 'web'
            AND s.app_origin = 'chat'`,
        [ws.id],
      )
      expect(rooms.rows).toHaveLength(1)
      const room = rooms.rows[0]
      expect(room.title).toBe('General')
      expect(room.title_manually_set).toBe(true)
      expect(room.user_id).toBe(userId)
      expect(room.kind).toBe('primary')
      // The room's read floor is the assistant's clearance.
      expect(room.effective_clearance).toBe(room.assistant_clearance)
    } finally {
      if (workspaceId) {
        await client.query(`DELETE FROM sessions WHERE workspace_id = $1`, [workspaceId])
        await client.query(`DELETE FROM assistants WHERE workspace_id = $1`, [workspaceId])
        await client.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId])
      }
      if (userId) await client.query(`DELETE FROM users WHERE id = $1`, [userId])
      client.release()
    }
  })

  it('the 388 backfill inserts exactly one General per room-less workspace and is idempotent', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const userId = await makeUser(client)
      // A pre-multiplayer workspace: workspace + primary assistant, NO room.
      const ws = await client.query(
        `INSERT INTO workspaces (name, purpose, owner_user_id)
         VALUES ('Backfill WS', 'fixture', $1) RETURNING id`,
        [userId],
      )
      const workspaceId = ws.rows[0].id
      await client.query(
        `INSERT INTO assistants (name, owner_user_id, workspace_id, kind)
         VALUES ('Backfill Primary', NULL, $1, 'primary')`,
        [workspaceId],
      )

      const countRooms = async () => {
        const r = await client.query(
          `SELECT count(*)::int AS n FROM sessions
            WHERE workspace_id = $1 AND visibility = 'workspace'
              AND channel_type = 'web' AND app_origin = 'chat'`,
          [workspaceId],
        )
        return r.rows[0].n as number
      }

      expect(await countRooms()).toBe(0)
      await client.query(backfillSql())
      expect(await countRooms()).toBe(1)
      // Idempotent: a second run inserts nothing.
      await client.query(backfillSql())
      expect(await countRooms()).toBe(1)

      const room = await client.query(
        `SELECT title, title_manually_set FROM sessions
          WHERE workspace_id = $1 AND app_origin = 'chat' AND visibility = 'workspace'`,
        [workspaceId],
      )
      expect(room.rows[0].title).toBe('General')
      expect(room.rows[0].title_manually_set).toBe(true)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
