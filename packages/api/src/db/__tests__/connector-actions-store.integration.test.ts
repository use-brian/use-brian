import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'
import type { ConnectorAction, CreateConnectorActionParams } from '../connector-actions-store.js'
import { createDbConnectorActionStore } from '../connector-actions-store.js'
import { query } from '../client.js'

/**
 * Integration tests for createDbConnectorActionStore (WU-6.6).
 *
 * Requires the local `Use Brian` PostgreSQL database with migration 136
 * (`connector_actions`, WU-6.1) applied. Skips silently when the DB isn't
 * reachable OR when migration 136 hasn't run yet — WU-6.1 is a separate
 * work unit, and this suite is a no-op until it ships.
 *
 * Spec: docs/plans/company-brain/connector-actions.md.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  // Probe through client.js's `query` — the same pool the store-under-test
  // uses. A hardcoded `Use Brian` pool would skip-guard the wrong
  // connection: the store resolves its DB from DATABASE_URL, so guarding a
  // fixed db name lets the suite run (and fail) when the two diverge.
  // Migration 136 + the SV 2026-05-14 `source_memory_id` column must exist.
  try {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'connector_actions'
           AND column_name = 'source_memory_id'
       ) AS exists`,
    )
    if (!result.rows[0]?.exists) return false
  } catch {
    return false
  }
  pool = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  return true
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip
if (!ok) {
  console.log('[connector-actions-store integration] skipped — connector_actions schema not reachable via the store DB (migration 136 / DATABASE_URL).')
}

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'cas-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'cas-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function makeAssistant(client: pg.PoolClient, workspaceId: string, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'cas-asst', $2, $1)
     RETURNING id`,
    [workspaceId, ownerId],
  )
  return r.rows[0].id
}

async function makeEpisode(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  // Minimal episode insert — sets migration 129's NOT-NULL `episodes`
  // columns with no default (`source_ref`, `created_by_user_id`) plus a
  // `user_id` to satisfy the visibility-double check (`user_id` OR `assistant_id`).
  const r = await client.query(
    `INSERT INTO episodes (workspace_id, source_kind, source_ref, occurred_at, content_ref, sensitivity, user_id, created_by_user_id)
     VALUES ($1, 'connector_action', '{}'::jsonb, now(), '{}'::jsonb, 'internal', $2, $2)
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

async function makeMemory(client: pg.PoolClient, workspaceId: string, assistantId: string, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO memories (assistant_id, user_id, workspace_id, scope, summary, sensitivity, source, tags)
     VALUES ($1, $2, $3, 'workspace', 'commitment under test', 'internal', 'model', ARRAY['commitment:open','commitment:investor_signal'])
     RETURNING id`,
    [assistantId, userId, workspaceId],
  )
  return r.rows[0].id
}

function baseParams(opts: {
  workspaceId: string
  episodeId: string
  userId: string
  assistantId: string
}): CreateConnectorActionParams {
  return {
    workspaceId: opts.workspaceId,
    episodeId: opts.episodeId,
    connectorId: 'gmail',
    actionKind: 'send_email',
    payload: { to: 'acme@example.com', subject: 'hi' },
    initiatedByUserId: opts.userId,
    initiatedByAssistantId: opts.assistantId,
    retrievalSensitivityMax: 'internal',
    audienceClearance: 'public',
    responseCeiling: 'public',
    status: 'executed',
  }
}

describeIf('[COMP:brain/connector-action-source-memory-link] connector_actions ↔ commitment-memory backlink', () => {
  it('persists source_memory_id when supplied on create', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const userId = await makeUser(client)
      const workspaceId = await makeWorkspace(client, userId)
      const assistantId = await makeAssistant(client, workspaceId, userId)
      const episodeId = await makeEpisode(client, workspaceId, userId)
      const memoryId = await makeMemory(client, workspaceId, assistantId, userId)
      await client.query('COMMIT')

      const store = createDbConnectorActionStore()
      const action: ConnectorAction = await store.create({
        ...baseParams({ workspaceId, episodeId, userId, assistantId }),
        sourceMemoryId: memoryId,
      })

      expect(action.sourceMemoryId).toBe(memoryId)
      expect(action.workspaceId).toBe(workspaceId)
      expect(action.connectorId).toBe('gmail')
      expect(action.status).toBe('executed')
    } finally {
      client.release()
    }
  })

  it('leaves source_memory_id null when omitted', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const userId = await makeUser(client)
      const workspaceId = await makeWorkspace(client, userId)
      const assistantId = await makeAssistant(client, workspaceId, userId)
      const episodeId = await makeEpisode(client, workspaceId, userId)
      await client.query('COMMIT')

      const store = createDbConnectorActionStore()
      const action = await store.create(baseParams({ workspaceId, episodeId, userId, assistantId }))
      expect(action.sourceMemoryId).toBeNull()
    } finally {
      client.release()
    }
  })

  it('listBySourceMemory returns broadcasts in created-at order; excludes null links', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const userId = await makeUser(client)
      const workspaceId = await makeWorkspace(client, userId)
      const assistantId = await makeAssistant(client, workspaceId, userId)
      const memoryId = await makeMemory(client, workspaceId, assistantId, userId)
      const e1 = await makeEpisode(client, workspaceId, userId)
      const e2 = await makeEpisode(client, workspaceId, userId)
      const eUnrelated = await makeEpisode(client, workspaceId, userId)
      await client.query('COMMIT')

      const store = createDbConnectorActionStore()
      const first = await store.create({
        ...baseParams({ workspaceId, episodeId: e1, userId, assistantId }),
        sourceMemoryId: memoryId,
      })
      // Brief wait so created_at differs (Postgres now() has microsecond granularity but transactions can collide).
      await new Promise((r) => setTimeout(r, 10))
      const second = await store.create({
        ...baseParams({ workspaceId, episodeId: e2, userId, assistantId }),
        sourceMemoryId: memoryId,
      })
      // Action without backlink — must NOT appear in the result.
      await store.create({
        ...baseParams({ workspaceId, episodeId: eUnrelated, userId, assistantId }),
      })

      const history = await store.listBySourceMemory(memoryId)
      expect(history.map((a) => a.id)).toEqual([first.id, second.id])
    } finally {
      client.release()
    }
  })

  it('idempotency_key collision returns the existing row instead of inserting twice', async () => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      const userId = await makeUser(client)
      const workspaceId = await makeWorkspace(client, userId)
      const assistantId = await makeAssistant(client, workspaceId, userId)
      const memoryId = await makeMemory(client, workspaceId, assistantId, userId)
      const episodeId = await makeEpisode(client, workspaceId, userId)
      await client.query('COMMIT')

      const store = createDbConnectorActionStore()
      const key = `idemp-${Math.random().toString(36).slice(2)}`
      const first = await store.create({
        ...baseParams({ workspaceId, episodeId, userId, assistantId }),
        sourceMemoryId: memoryId,
        idempotencyKey: key,
      })
      const second = await store.create({
        ...baseParams({ workspaceId, episodeId, userId, assistantId }),
        sourceMemoryId: memoryId,
        idempotencyKey: key,
      })
      expect(second.id).toBe(first.id)
    } finally {
      client.release()
    }
  })
})

// Type-level sanity — always runs (no DB). Compilation alone is the assertion.
describe('[COMP:brain/connector-action-source-memory-link] type surface', () => {
  it('CreateConnectorActionParams carries sourceMemoryId', () => {
    const p: CreateConnectorActionParams = {
      workspaceId: 'w',
      episodeId: 'e',
      connectorId: 'gmail',
      actionKind: 'send_email',
      payload: {},
      initiatedByUserId: 'u',
      initiatedByAssistantId: 'a',
      retrievalSensitivityMax: 'internal',
      audienceClearance: 'public',
      responseCeiling: 'public',
      status: 'executed',
      sourceMemoryId: 'm-1',
    }
    expect(p.sourceMemoryId).toBe('m-1')
  })
})
