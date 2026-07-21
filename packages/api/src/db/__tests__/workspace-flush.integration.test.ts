/**
 * Integration test for `flushWorkspaceData` — the workspace "delete all data"
 * primitive. Component tag: [COMP:api/workspace-flush].
 *
 * Requires a local PostgreSQL named `sidanclaw` at current-migration schema;
 * skips silently when the DB is unavailable or behind.
 *
 * What we verify:
 *   1. CLASSIFICATION COMPLETENESS — every base table carrying a
 *      `workspace_id` column is in exactly one of WORKSPACE_FLUSH_TABLES /
 *      WORKSPACE_FLUSH_PRESERVED_TABLES. A new migration that adds a
 *      workspace-scoped table fails here until it's classified, which is the
 *      whole defense against "delete memories didn't clear all brain entries"
 *      recurring one table at a time.
 *   2. FLUSH BEHAVIOR — content rows (memories, tasks, workflows + runs,
 *      pages, entities, episodes, connector_actions, assistant-scoped
 *      scheduled jobs, sessions) are deleted; the shell (workspace, member
 *      row, assistant, channel) survives. Works on a PERSONAL workspace —
 *      the un-deletable one this feature exists for.
 *   3. OWNERSHIP — a non-owner caller is rejected without deleting anything.
 *
 * Spec: docs/architecture/platform/workspaces.md → "Workspace data flush".
 */

import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Bail unless the newest tables the flush lists reference exist —
      // otherwise a behind-schema local DB reads as a classification bug.
      const probe = await client.query<{ a: string | null; b: string | null }>(
        `SELECT to_regclass('public.brain_candidates')::text AS a,
                to_regclass('public.metered_model_surcharges')::text AS b`,
      )
      if (!probe.rows[0]?.a || !probe.rows[0]?.b) return false
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

// The SUT's getPool() singleton must land on the same local DB this test
// probed. Import dynamically after setting the env (vitest runs files in
// isolated processes, so the singleton can't have been built earlier).
async function loadSUT() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/sidanclaw'
  return import('../workspace-flush.js')
}

type Seeded = {
  userId: string
  otherUserId: string
  workspaceId: string
  assistantId: string
}

async function seedWorkspace(client: pg.PoolClient): Promise<Seeded> {
  const { rows: [u] } = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'ws-flush-' || gen_random_uuid()) RETURNING id`,
  )
  const { rows: [o] } = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'ws-flush-other-' || gen_random_uuid()) RETURNING id`,
  )
  // PERSONAL workspace — the case this feature exists for.
  const { rows: [w] } = await client.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'ws-flush-test', 'test', $1, true) RETURNING id`,
    [u.id],
  )
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [w.id, u.id],
  )
  const { rows: [a] } = await client.query<{ id: string }>(
    `INSERT INTO assistants (id, name, workspace_id, kind, owner_user_id)
     VALUES (gen_random_uuid(), 'ws-flush-primary', $1, 'primary', $2) RETURNING id`,
    [w.id, u.id],
  )
  return { userId: u.id, otherUserId: o.id, workspaceId: w.id, assistantId: a.id }
}

async function seedContent(client: pg.PoolClient, s: Seeded) {
  const ids: Record<string, string> = {}
  const grab = async (sql: string, params: unknown[]) =>
    (await client.query<{ id: string }>(sql, params)).rows[0].id

  ids.memory = await grab(
    `INSERT INTO memories (id, user_id, workspace_id, assistant_id, summary)
     VALUES (gen_random_uuid(), $1, $2, $3, 'flush-mem') RETURNING id`,
    [s.userId, s.workspaceId, s.assistantId],
  )
  ids.task = await grab(
    `INSERT INTO tasks (id, workspace_id, title, status, assistant_id, created_by_assistant_id, user_id)
     VALUES (gen_random_uuid(), $1, 'flush-task', 'todo', $2, $2, $3) RETURNING id`,
    [s.workspaceId, s.assistantId, s.userId],
  )
  ids.workflow = await grab(
    `INSERT INTO workflows (id, workspace_id, created_by, name, definition)
     VALUES (gen_random_uuid(), $1, $2, 'flush-wf', '{"steps":[]}') RETURNING id`,
    [s.workspaceId, s.userId],
  )
  ids.run = await grab(
    `INSERT INTO workflow_runs (id, workflow_id, workspace_id, trigger_kind, status)
     VALUES (gen_random_uuid(), $1, $2, 'manual', 'completed') RETURNING id`,
    [ids.workflow, s.workspaceId],
  )
  ids.page = await grab(
    `INSERT INTO saved_views (id, workspace_id, created_by, name, entity, view_type)
     VALUES (gen_random_uuid(), $1, $2, 'flush-page', 'tasks', 'table') RETURNING id`,
    [s.workspaceId, s.userId],
  )
  ids.entity = await grab(
    `INSERT INTO entities (id, workspace_id, kind, display_name, created_by_user_id, user_id, source)
     VALUES (gen_random_uuid(), $1, 'person', 'flush-contact', $2, $2, 'test') RETURNING id`,
    [s.workspaceId, s.userId],
  )
  ids.episode = await grab(
    `INSERT INTO episodes (id, workspace_id, source_kind, source_ref, occurred_at, created_by_user_id, user_id)
     VALUES (gen_random_uuid(), $1, 'chat', '{}', now(), $2, $2) RETURNING id`,
    [s.workspaceId, s.userId],
  )
  ids.connectorAction = await grab(
    `INSERT INTO connector_actions (id, workspace_id, episode_id, connector_id, action_kind, payload,
        initiated_by_user_id, initiated_by_assistant_id, retrieval_sensitivity_max, audience_clearance,
        response_ceiling, status)
     VALUES (gen_random_uuid(), $1, $2, 'gmail', 'send', '{}', $3, $4, 'internal', 'internal',
        'internal', 'executed') RETURNING id`,
    [s.workspaceId, ids.episode, s.userId, s.assistantId],
  )
  ids.job = await grab(
    `INSERT INTO scheduled_jobs (id, assistant_id, user_id, schedule, timezone, instructions,
        channel_type, channel_id, next_run_at)
     VALUES (gen_random_uuid(), $1, $2, '{"type":"daily"}', 'UTC', 'flush-job', 'cron', 'cron',
        now() + interval '1 day') RETURNING id`,
    [s.assistantId, s.userId],
  )
  // Session with NULL workspace_id — the personal-assistant shape; must be
  // caught by the OR-assistant predicate.
  ids.session = await grab(
    `INSERT INTO sessions (id, user_id, assistant_id, channel_type, channel_id)
     VALUES (gen_random_uuid(), $1, $2, 'web', 'flush-session') RETURNING id`,
    [s.userId, s.assistantId],
  )
  // A preserved-shell row: a channel binding survives the flush.
  ids.channel = await grab(
    `INSERT INTO channels (id, workspace_id, channel_type, display_name)
     VALUES (gen_random_uuid(), $1, 'telegram', 'flush-chan') RETURNING id`,
    [s.workspaceId],
  )
  return ids
}

async function countRow(table: string, id: string): Promise<number> {
  const r = await pool!.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])
  return r.rowCount ?? 0
}

describeIf('[COMP:api/workspace-flush] workspace data flush (integration)', () => {
  it('classifies every workspace_id table into exactly one flush/preserve list', async () => {
    const { WORKSPACE_FLUSH_TABLES, WORKSPACE_FLUSH_PRESERVED_TABLES } = await loadSUT()
    const flush = new Set<string>(WORKSPACE_FLUSH_TABLES)
    const preserved = new Set<string>(WORKSPACE_FLUSH_PRESERVED_TABLES)

    const r = await pool!.query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        WHERE c.column_name = 'workspace_id' AND c.table_schema = 'public'`,
    )
    const actual = new Set(r.rows.map((row) => row.table_name))

    const unclassified = [...actual].filter((tbl) => !flush.has(tbl) && !preserved.has(tbl)).sort()
    const stale = [...flush, ...preserved].filter((tbl) => !actual.has(tbl)).sort()
    const doubled = [...flush].filter((tbl) => preserved.has(tbl)).sort()

    expect(unclassified, 'new workspace_id tables must be classified in workspace-flush.ts').toEqual([])
    expect(stale, 'flush lists reference tables that no longer exist').toEqual([])
    expect(doubled, 'a table cannot be both flushed and preserved').toEqual([])
  })

  it('flushes all content on a personal workspace, preserving the shell', async () => {
    const { flushWorkspaceData } = await loadSUT()
    const client = await pool!.connect()
    let s: Seeded | undefined
    try {
      s = await seedWorkspace(client)
      const ids = await seedContent(client, s)

      const result = await flushWorkspaceData(s.userId, s.workspaceId)

      // Content is gone.
      expect(await countRow('memories', ids.memory)).toBe(0)
      expect(await countRow('tasks', ids.task)).toBe(0)
      expect(await countRow('workflows', ids.workflow)).toBe(0)
      expect(await countRow('workflow_runs', ids.run)).toBe(0)
      expect(await countRow('saved_views', ids.page)).toBe(0)
      expect(await countRow('entities', ids.entity)).toBe(0)
      expect(await countRow('episodes', ids.episode)).toBe(0)
      expect(await countRow('connector_actions', ids.connectorAction)).toBe(0)
      expect(await countRow('scheduled_jobs', ids.job)).toBe(0)
      expect(await countRow('sessions', ids.session)).toBe(0)

      // Shell survives.
      expect(await countRow('workspaces', s.workspaceId)).toBe(1)
      expect(await countRow('assistants', s.assistantId)).toBe(1)
      expect(await countRow('channels', ids.channel)).toBe(1)
      const member = await pool!.query(
        `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [s.workspaceId, s.userId],
      )
      expect(member.rowCount).toBe(1)

      // Counts report the top-level deletes.
      expect(result.deleted.memories).toBe(1)
      expect(result.deleted.tasks).toBe(1)
      expect(result.deleted.workflows).toBe(1)
      expect(result.deleted.sessions).toBe(1)
      expect(result.deleted.scheduled_jobs).toBe(1)
      expect(result.total).toBeGreaterThanOrEqual(8)
    } finally {
      if (s) {
        // User delete cascades the workspace and anything the test left over.
        await pool!.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [s.userId, s.otherUserId],
        ]).catch(() => {})
      }
      client.release()
    }
  })

  it('rejects a non-owner without deleting anything', async () => {
    const { flushWorkspaceData, WorkspaceFlushNotOwnerError } = await loadSUT()
    const client = await pool!.connect()
    let s: Seeded | undefined
    try {
      s = await seedWorkspace(client)
      const ids = await seedContent(client, s)

      await expect(flushWorkspaceData(s.otherUserId, s.workspaceId)).rejects.toBeInstanceOf(
        WorkspaceFlushNotOwnerError,
      )
      expect(await countRow('tasks', ids.task)).toBe(1)
      expect(await countRow('memories', ids.memory)).toBe(1)
    } finally {
      if (s) {
        await pool!.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [s.userId, s.otherUserId],
        ]).catch(() => {})
      }
      client.release()
    }
  })
})
