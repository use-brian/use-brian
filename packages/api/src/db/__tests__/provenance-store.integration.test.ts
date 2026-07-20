import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@use-brian/core'

/**
 * Integration tests for WU-5.5 — the `provenance` derivation chain.
 *
 * `provenance-store.test.ts` covers the UUID gate without a database.
 * This suite exercises the real `derived_from` + `re_extracted_at`
 * derivation walks against a live `Use Brian` PostgreSQL with migrations
 * through 132 applied. Skips silently when the DB is unavailable.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §`provenance(row_id)`
 * output shape + data-model.md §"Provenance pattern".
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT source, source_episode_id, superseded_by FROM memories LIMIT 1')
      await client.query('SELECT id FROM episodes LIMIT 1')
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

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'prov-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'prov-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

async function makeAssistant(client: pg.PoolClient, ownerId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'prov-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

async function insertEpisode(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    userId: string
    occurredAt: Date
    sensitivity?: 'public' | 'internal' | 'confidential'
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO episodes (
       source_kind, source_ref, occurred_at, sensitivity,
       user_id, workspace_id, created_by_user_id
     ) VALUES ('web_chat', '{}'::jsonb, $1, $2, $3, $4, $3)
     RETURNING id`,
    [params.occurredAt, params.sensitivity ?? 'internal', params.userId, params.workspaceId],
  )
  return r.rows[0].id
}

async function insertMemory(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    userId: string
    assistantId: string
    summary: string
    source: string
    sourceEpisodeId?: string | null
    validFrom?: Date
    validTo?: Date | null
    supersededBy?: string | null
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO memories (
       assistant_id, user_id, workspace_id, scope, tags, summary,
       confidence, sensitivity, source, source_episode_id, created_by_user_id,
       valid_from, valid_to, superseded_by
     ) VALUES (
       $1, $2, $3, 'workspace', '{}', $4,
       0.9, 'internal', $5, $6, $2,
       COALESCE($7::timestamptz, now()), $8, $9
     ) RETURNING id`,
    [
      params.assistantId,
      params.userId,
      params.workspaceId,
      params.summary,
      params.source,
      params.sourceEpisodeId ?? null,
      params.validFrom ?? null,
      params.validTo ?? null,
      params.supersededBy ?? null,
    ],
  )
  return r.rows[0].id
}

describeIf('[COMP:retrieval/provenance] provenance derivation chain (integration)', () => {
  let store: typeof import('../provenance-store.js')
  let userId: string
  let assistantId: string
  let workspaceId: string
  let actor: RetrievalActor

  beforeEach(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../provenance-store.js')
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
      actor = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
    } finally {
      client.release()
    }
  })

  it('derived_from carries the source Episode as extracted_from for source=extracted', async () => {
    const client = await pool!.connect()
    let episodeId: string
    let memoryId: string
    try {
      episodeId = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-01T10:00:00Z'),
      })
      memoryId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'extracted fact', source: 'extracted', sourceEpisodeId: episodeId,
      })
    } finally {
      client.release()
    }

    const result = await store.createDbProvenanceStore().provenance(actor, { row_id: memoryId })
    expect(result).not.toBeNull()
    expect(result!.data.derived_from).toEqual([
      { primitive: 'episode', row_id: episodeId, relationship: 'extracted_from' },
    ])
    expect(result!.data.source_episode?.id).toBe(episodeId)
  })

  it('derived_from types a rem_connection source as inferred_from', async () => {
    const client = await pool!.connect()
    let episodeId: string
    let memoryId: string
    try {
      episodeId = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-01T10:00:00Z'),
      })
      memoryId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'REM-inferred fact', source: 'rem_connection', sourceEpisodeId: episodeId,
      })
    } finally {
      client.release()
    }

    const result = await store.createDbProvenanceStore().provenance(actor, { row_id: memoryId })
    expect(result!.data.derived_from[0]?.relationship).toBe('inferred_from')
  })

  it('derived_from is empty when the row has no source Episode', async () => {
    const client = await pool!.connect()
    let memoryId: string
    try {
      memoryId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'directly-entered fact', source: 'user', sourceEpisodeId: null,
      })
    } finally {
      client.release()
    }

    const result = await store.createDbProvenanceStore().provenance(actor, { row_id: memoryId })
    expect(result!.data.derived_from).toEqual([])
    expect(result!.data.source_episode).toBeNull()
  })

  it('re_extracted_at collects each prior version Episode in the supersession chain', async () => {
    const client = await pool!.connect()
    let headId: string
    let ep1: string
    let ep2: string
    try {
      ep1 = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-01T10:00:00Z'),
      })
      ep2 = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-05T10:00:00Z'),
      })
      const ep3 = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-10T10:00:00Z'),
      })
      // Three-version chain: v1 (ep1) → v2 (ep2) → v3 (ep3, head).
      headId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'v3', source: 'extracted', sourceEpisodeId: ep3,
        validFrom: new Date('2026-05-10T10:00:00Z'),
      })
      const v2 = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'v2', source: 'extracted', sourceEpisodeId: ep2,
        validFrom: new Date('2026-05-05T10:00:00Z'),
        validTo: new Date('2026-05-10T10:00:00Z'),
        supersededBy: headId,
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'v1', source: 'extracted', sourceEpisodeId: ep1,
        validFrom: new Date('2026-05-01T10:00:00Z'),
        validTo: new Date('2026-05-05T10:00:00Z'),
        supersededBy: v2,
      })
    } finally {
      client.release()
    }

    const result = await store.createDbProvenanceStore().provenance(actor, { row_id: headId })
    expect(result).not.toBeNull()
    // Oldest → newest re-extraction events: v1's ep1, then v2's ep2.
    expect(result!.data.re_extracted_at.map((r) => r.from_episode)).toEqual([ep1, ep2])
    // The head's own source episode is in supersession + source_episode,
    // not in re_extracted_at (that's the prior versions only).
    expect(result!.data.supersession.preceded_by).toBeTruthy()
  })

  it('re_extracted_at is empty for a single-version row', async () => {
    const client = await pool!.connect()
    let memoryId: string
    try {
      const ep = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-01T10:00:00Z'),
      })
      memoryId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'solo', source: 'extracted', sourceEpisodeId: ep,
      })
    } finally {
      client.release()
    }

    const result = await store.createDbProvenanceStore().provenance(actor, { row_id: memoryId })
    expect(result!.data.re_extracted_at).toEqual([])
  })

  it('omits an inaccessible source Episode from derived_from (P1-8 silent redaction)', async () => {
    const client = await pool!.connect()
    let memoryId: string
    try {
      // Episode classified confidential; the memory itself stays internal
      // so the row is visible but its origin Episode is above an
      // internal-clearance viewer.
      const ep = await insertEpisode(client, {
        workspaceId, userId, occurredAt: new Date('2026-05-01T10:00:00Z'),
        sensitivity: 'confidential',
      })
      memoryId = await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'fact from a confidential episode', source: 'extracted', sourceEpisodeId: ep,
      })
    } finally {
      client.release()
    }

    const lowClearance: RetrievalActor = { ...actor, clearance: 'internal' }
    const result = await store
      .createDbProvenanceStore()
      .provenance(lowClearance, { row_id: memoryId })
    expect(result).not.toBeNull()
    // P1-8: the inaccessible Episode is omitted entirely — no handle.
    expect(result!.data.source_episode).toBeNull()
    expect(result!.data.derived_from).toEqual([])
  })
})
