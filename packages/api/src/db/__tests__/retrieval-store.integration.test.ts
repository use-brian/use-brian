import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@use-brian/core'

/**
 * Integration tests for WU-5.3 — `search` + `recentEpisodes` of the
 * `RetrievalStore` surface. Requires a local `Use Brian` PostgreSQL
 * database with migrations through 132 applied (universal columns +
 * entities + entity_links + episodes + kb_chunks). Skips silently when
 * the DB is unavailable or required migrations haven't landed.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe the columns the store reads to fail fast when migrations
      // 128 / 125 / 129 / 132 aren't applied.
      await client.query('SELECT valid_to, retracted_at FROM memories LIMIT 1')
      await client.query('SELECT id FROM entities LIMIT 1')
      await client.query('SELECT id FROM episodes LIMIT 1')
      await client.query('SELECT id FROM entity_links LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'retrieval-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'retrieval-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

async function makeAssistant(
  client: pg.PoolClient,
  ownerId: string,
  workspaceId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'retrieval-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
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
    detail?: string
    tags?: string[]
    sensitivity?: 'public' | 'internal' | 'confidential'
    validFrom?: Date
    validTo?: Date | null
    createdByUserId?: string
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO memories (
       assistant_id, user_id, workspace_id, scope, tags, summary, detail,
       confidence, sensitivity, source, created_by_user_id, valid_from, valid_to
     ) VALUES (
       $1, $2, $3, 'workspace', $4, $5, $6,
       0.9, $7, 'user', $8, COALESCE($9::timestamptz, now()), $10
     ) RETURNING id`,
    [
      params.assistantId,
      params.userId,
      params.workspaceId,
      params.tags ?? [],
      params.summary,
      params.detail ?? null,
      params.sensitivity ?? 'internal',
      params.createdByUserId ?? params.userId,
      params.validFrom ?? null,
      params.validTo ?? null,
    ],
  )
  return r.rows[0].id
}

async function insertEntity(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    userId: string
    displayName: string
    kind?: string
    canonicalId?: string | null
    sensitivity?: 'public' | 'internal' | 'confidential'
    createdByUserId: string
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO entities (
       kind, display_name, canonical_id, workspace_id, user_id, sensitivity,
       source, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'user', $7)
     RETURNING id`,
    [
      params.kind ?? 'company',
      params.displayName,
      params.canonicalId ?? null,
      params.workspaceId,
      params.userId,
      params.sensitivity ?? 'internal',
      params.createdByUserId,
    ],
  )
  return r.rows[0].id
}

async function insertEpisode(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    userId: string
    sourceKind: string
    occurredAt: Date
    sensitivity?: 'public' | 'internal' | 'confidential'
    createdByUserId: string
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO episodes (
       source_kind, source_ref, occurred_at, sensitivity,
       user_id, workspace_id, created_by_user_id
     ) VALUES ($1, '{}'::jsonb, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      params.sourceKind,
      params.occurredAt,
      params.sensitivity ?? 'internal',
      params.userId,
      params.workspaceId,
      params.createdByUserId,
    ],
  )
  return r.rows[0].id
}

async function insertEntityEpisodeLink(
  client: pg.PoolClient,
  params: {
    workspaceId: string
    userId: string
    entityId: string
    episodeId: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO entity_links (
       source_kind, source_id, target_kind, target_id, edge_type,
       workspace_id, user_id, sensitivity, source
     ) VALUES (
       'entity', $1, 'episode', $2, 'discussed_in',
       $3, $4, 'internal', 'user'
     )`,
    [params.entityId, params.episodeId, params.workspaceId, params.userId],
  )
}

describeIf('[COMP:retrieval/search] retrieval-store.search (integration)', () => {
  let store: typeof import('../retrieval-store.js')
  let userId: string
  let assistantId: string
  let workspaceId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../retrieval-store.js')
  })

  beforeEach(async () => {
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

  it('FTS prefix-matches memories on summary', async () => {
    const client = await pool!.connect()
    try {
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'pricing strategy for Q3 launch',
        tags: ['pricing'],
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'unrelated note about onboarding',
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'pricing', scope: 'memory' })
    expect(out.api_version).toBe('v1')
    expect(out.data.length).toBe(1)
    expect(out.data[0].primitive).toBe('memory')
    expect(out.data[0].summary).toBe('pricing strategy for Q3 launch')
  })

  it('ILIKE fallback on entity display_name', async () => {
    const client = await pool!.connect()
    try {
      // kind='project' (non-CRM): the 'entity' scope excludes
      // person/company/deal (Q24 — those surface via their own scopes).
      await insertEntity(client, {
        workspaceId, userId,
        kind: 'project',
        displayName: 'Acme Corp',
        createdByUserId: userId,
      })
      await insertEntity(client, {
        workspaceId, userId,
        kind: 'project',
        displayName: 'Globex Inc',
        createdByUserId: userId,
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'acme', scope: 'entity' })
    expect(out.data.length).toBe(1)
    expect(out.data[0].display_name).toBe('Acme Corp')
  })

  it('memory FTS-miss falls back to ILIKE without parameter-type error', async () => {
    const client = await pool!.connect()
    try {
      // 'foobarbaz' tokenizes as a single 'foobarbaz' token under the
      // 'simple' tsvector config — `to_tsquery('simple', 'bar:*')` does
      // NOT prefix-match it, so FTS returns zero rows and the fallback
      // path runs. ILIKE `%bar%` matches the substring.
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'foobarbaz placeholder',
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'unrelated note about onboarding',
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'bar', scope: 'memory' })
    expect(out.data.length).toBe(1)
    expect(out.data[0].summary).toBe('foobarbaz placeholder')
  })

  it('sensitivity ceiling hides confidential rows from internal-clearance actors', async () => {
    const client = await pool!.connect()
    try {
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'pricing-confidential secret',
        sensitivity: 'confidential',
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'pricing-internal common',
        sensitivity: 'internal',
      })
    } finally {
      client.release()
    }

    const restricted: RetrievalActor = { ...actor, clearance: 'internal' }
    const out = await store.search(restricted, { query: 'pricing', scope: 'memory' })
    expect(out.data.length).toBe(1)
    expect(out.data[0].summary).toBe('pricing-internal common')
  })

  it('tag filter narrows results', async () => {
    const client = await pool!.connect()
    try {
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'note alpha', tags: ['pricing'],
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'note bravo', tags: ['other'],
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, {
      query: 'note',
      scope: 'memory',
      filters: { tag: 'pricing' },
    })
    expect(out.data.length).toBe(1)
    expect(out.data[0].summary).toBe('note alpha')
  })

  it('unknown filter key throws plain error', async () => {
    await expect(
      store.search(actor, {
        query: 'anything',
        scope: 'memory',
        filters: { not_a_real_filter: 'x' },
      }),
    ).rejects.toThrow(/unknown filter key/)
  })

  it('rejects non-ISO since filter', async () => {
    await expect(
      store.search(actor, {
        query: 'anything',
        scope: 'memory',
        filters: { since: 'last_week' },
      }),
    ).rejects.toThrow(/ISO timestamp/)
  })

  it('cursor round-trip paginates the merged result set', async () => {
    const client = await pool!.connect()
    try {
      for (let i = 0; i < 3; i += 1) {
        await insertMemory(client, {
          workspaceId, userId, assistantId,
          summary: `pricing item ${i}`,
        })
      }
    } finally {
      client.release()
    }

    const page1 = await store.search(actor, { query: 'pricing', scope: 'memory', limit: 2 })
    expect(page1.data.length).toBe(2)
    expect(page1.meta.truncated).toBe(true)
    expect(page1.meta.cursor).toBeTruthy()

    const page2 = await store.search(actor, {
      query: 'pricing',
      scope: 'memory',
      limit: 2,
      cursor: page1.meta.cursor!,
    })
    expect(page2.data.length).toBe(1)
    expect(page2.meta.truncated).toBe(false)
    expect(page2.meta.cursor).toBeNull()

    const ids = new Set<string>([
      ...page1.data.map((r) => r.row_id),
      ...page2.data.map((r) => r.row_id),
    ])
    expect(ids.size).toBe(3)
  })

  it('bi-temporal as_of suppresses rows whose valid_from is in the future', async () => {
    const client = await pool!.connect()
    try {
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'future note',
        validFrom: new Date('2099-01-01T00:00:00Z'),
      })
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'present note',
      })
    } finally {
      client.release()
    }

    const presentOnly = await store.search(actor, {
      query: 'note',
      scope: 'memory',
      as_of: '2030-01-01T00:00:00Z',
    })
    expect(presentOnly.data.map((r) => r.summary)).toEqual(['present note'])
  })

  it('rejects unknown scope', async () => {
    await expect(
      store.search(actor, { query: 'x', scope: 'not_a_scope' }),
    ).rejects.toThrow(/unknown scope/)
  })

  it('fans out across all scopes when scope is undefined', async () => {
    const client = await pool!.connect()
    try {
      await insertMemory(client, {
        workspaceId, userId, assistantId,
        summary: 'crossref alpha',
      })
      await insertEntity(client, {
        workspaceId, userId,
        kind: 'project',
        displayName: 'crossref beta',
        createdByUserId: userId,
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'crossref' })
    const primitives = new Set(out.data.map((r) => r.primitive))
    expect(primitives.has('memory')).toBe(true)
    expect(primitives.has('entity')).toBe(true)
  })
})

describeIf('[COMP:retrieval/recent-episodes] retrieval-store.recentEpisodes (integration)', () => {
  let store: typeof import('../retrieval-store.js')
  let userId: string
  let assistantId: string
  let workspaceId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../retrieval-store.js')
  })

  beforeEach(async () => {
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

  it('orders by occurred_at DESC by default', async () => {
    const client = await pool!.connect()
    let oldId: string
    let newId: string
    try {
      oldId = await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        createdByUserId: userId,
      })
      newId = await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-10T10:00:00Z'),
        createdByUserId: userId,
      })
    } finally {
      client.release()
    }

    const out = await store.recentEpisodes(actor, {})
    expect(out.data.length).toBe(2)
    expect(out.data[0].id).toBe(newId)
    expect(out.data[1].id).toBe(oldId)
  })

  it('entity anchor restricts to episodes linked via entity_links', async () => {
    const client = await pool!.connect()
    let linkedEpisodeId: string
    let entityId: string
    try {
      entityId = await insertEntity(client, {
        workspaceId, userId,
        displayName: 'Acme Linked',
        createdByUserId: userId,
      })
      linkedEpisodeId = await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        createdByUserId: userId,
      })
      // An unlinked episode — same workspace, no entity_links row.
      await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-02T10:00:00Z'),
        createdByUserId: userId,
      })
      await insertEntityEpisodeLink(client, {
        workspaceId, userId,
        entityId, episodeId: linkedEpisodeId,
      })
    } finally {
      client.release()
    }

    const out = await store.recentEpisodes(actor, { entity: entityId })
    expect(out.data.length).toBe(1)
    expect(out.data[0].id).toBe(linkedEpisodeId)
  })

  it('sensitivity ceiling hides confidential episodes from internal actors', async () => {
    const client = await pool!.connect()
    try {
      await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        sensitivity: 'confidential',
        createdByUserId: userId,
      })
      await insertEpisode(client, {
        workspaceId, userId,
        sourceKind: 'web_chat',
        occurredAt: new Date('2026-05-02T10:00:00Z'),
        sensitivity: 'internal',
        createdByUserId: userId,
      })
    } finally {
      client.release()
    }

    const restricted: RetrievalActor = { ...actor, clearance: 'internal' }
    const out = await store.recentEpisodes(restricted, {})
    expect(out.data.length).toBe(1)
    expect(out.data[0].sensitivity).toBe('internal')
  })

  it('cursor round-trip paginates the episode set', async () => {
    const client = await pool!.connect()
    try {
      for (let i = 0; i < 3; i += 1) {
        await insertEpisode(client, {
          workspaceId, userId,
          sourceKind: 'web_chat',
          occurredAt: new Date(Date.UTC(2026, 4, 1 + i, 10, 0, 0)),
          createdByUserId: userId,
        })
      }
    } finally {
      client.release()
    }

    const page1 = await store.recentEpisodes(actor, { limit: 2 })
    expect(page1.data.length).toBe(2)
    expect(page1.meta.truncated).toBe(true)
    expect(page1.meta.cursor).toBeTruthy()

    const page2 = await store.recentEpisodes(actor, {
      limit: 2,
      cursor: page1.meta.cursor!,
    })
    expect(page2.data.length).toBe(1)
    expect(page2.meta.truncated).toBe(false)
    expect(page2.meta.cursor).toBeNull()
  })

  it('rejects non-UUID entity input', async () => {
    await expect(
      store.recentEpisodes(actor, { entity: 'not-a-uuid' }),
    ).rejects.toThrow(/entity must be a UUID/)
  })

  it('rejects an unknown filter key', async () => {
    await expect(
      store.recentEpisodes(actor, { filters: { not_a_filter: 'x' } }),
    ).rejects.toThrow(/unknown filter key/)
  })
})
