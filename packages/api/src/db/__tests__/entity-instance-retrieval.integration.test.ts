import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@use-brian/core'

/**
 * Integration tests for the Doc v1 `entity_instance` retrieval path —
 * the title-only text index over `entity_instances` (migration 200) wired
 * into the unified brain `search()` and `provenance()`. Component tag:
 * [COMP:retrieval/entity-instance].
 *
 * Requires a local `Use Brian` PostgreSQL database with migration 200
 * applied (`entity_types` + `entity_instances`). Skips silently when the
 * DB is unavailable or the tables don't exist — mirrors the
 * `retrieval-store.integration.test.ts` skip pattern.
 *
 * What it exercises that the mock test can't:
 *   - The title-derivation JOIN actually resolves the first property's
 *     name and unwraps the `{kind,value}` cell to a plain string.
 *   - A targeted `scope='entity_instance'` search title-matches via ILIKE.
 *   - The `entity_type_id` filter narrows to one user-defined type.
 *   - The UNSCOPED cross-primitive search includes the entity-instance row.
 *   - `provenance()` resolves the row as a non-bi-temporal leaf carrying
 *     `source_app`.
 *
 * Spec: docs/plans/doc-v1-execution.md §5.2;
 *       docs/architecture/brain/retrieval-layer.md → "entity_instance".
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe migration 200's tables to fail fast when they aren't applied.
      await client.query('SELECT id, properties FROM entity_types LIMIT 1')
      await client.query(
        'SELECT id, entity_type_id, data, source_app, created_by FROM entity_instances LIMIT 1',
      )
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

/** True when `entity_links.created_by_user_id` exists (WS-4 backfill). */
async function hasEntityLinksAuthorship(): Promise<boolean> {
  const client = await pool!.connect()
  try {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'entity_links' AND column_name = 'created_by_user_id'
       ) AS exists`,
    )
    return r.rows[0]?.exists === true
  } finally {
    client.release()
  }
}

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'ei-retrieval-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'ei-retrieval-test-ws', 'test', $1, false)
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
     VALUES (gen_random_uuid(), 'ei-retrieval-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

/** Create an entity type whose FIRST property is the title column. */
async function makeMovieType(
  client: pg.PoolClient,
  workspaceId: string,
  createdBy: string,
): Promise<string> {
  const properties = [
    { name: 'title', label: 'Title', config: { kind: 'text' }, required: true },
    { name: 'rating', label: 'Rating', config: { kind: 'number' } },
  ]
  const r = await client.query<{ id: string }>(
    `INSERT INTO entity_types (workspace_id, name, icon, properties, created_by)
     VALUES ($1, 'Movie', '🎬', $2::jsonb, $3)
     RETURNING id`,
    [workspaceId, JSON.stringify(properties), createdBy],
  )
  return r.rows[0].id
}

/** Insert one row of a type; cells are `{kind,value}` keyed by prop name. */
async function makeMovie(
  client: pg.PoolClient,
  params: {
    entityTypeId: string
    workspaceId: string
    title: string
    rating?: number
    createdBy: string
    sourceApp?: 'doc' | 'chat' | 'import' | 'api'
  },
): Promise<string> {
  const data = {
    title: { kind: 'text', value: params.title },
    rating: { kind: 'number', value: params.rating ?? null },
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO entity_instances
       (entity_type_id, workspace_id, data, source_app, created_by, last_edited_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $5)
     RETURNING id`,
    [
      params.entityTypeId,
      params.workspaceId,
      JSON.stringify(data),
      params.sourceApp ?? 'doc',
      params.createdBy,
    ],
  )
  return r.rows[0].id
}

describeIf('[COMP:retrieval/entity-instance] entity_instance retrieval (integration)', () => {
  let store: typeof import('../retrieval-store.js')
  let provStore: typeof import('../provenance-store.js')
  let userId: string
  let assistantId: string
  let workspaceId: string
  let typeId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../retrieval-store.js')
    provStore = await import('../provenance-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
      typeId = await makeMovieType(client, workspaceId, userId)
      actor = {
        workspaceId,
        userId,
        assistantId,
        assistantKind: 'standard',
        clearance: 'confidential',
      }
    } finally {
      client.release()
    }
  })

  it('title-matches a user entity via the first-property derivation', async () => {
    const client = await pool!.connect()
    try {
      await makeMovie(client, { entityTypeId: typeId, workspaceId, title: 'The Matrix', rating: 9, createdBy: userId })
      await makeMovie(client, { entityTypeId: typeId, workspaceId, title: 'Inception', rating: 8, createdBy: userId })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'matrix', scope: 'entity_instance' })
    expect(out.api_version).toBe('v1')
    expect(out.data.length).toBe(1)
    const row = out.data[0]
    expect(row.primitive).toBe('entity_instance')
    expect(row.entity_type_id).toBe(typeId)
    expect(row.workspace_id).toBe(workspaceId)
    expect(row.title).toBe('The Matrix')
    expect(row.source_app).toBe('doc')
  })

  it('narrows by entity_type_id filter (scope-narrowed browse)', async () => {
    let otherTypeId: string
    const client = await pool!.connect()
    try {
      await makeMovie(client, { entityTypeId: typeId, workspaceId, title: 'Heat', createdBy: userId })
      // A second type with a same-titled row — the filter must exclude it.
      otherTypeId = await (async () => {
        const props = [{ name: 'title', label: 'Title', config: { kind: 'text' }, required: true }]
        const r = await client.query<{ id: string }>(
          `INSERT INTO entity_types (workspace_id, name, properties, created_by)
           VALUES ($1, 'Book', $2::jsonb, $3) RETURNING id`,
          [workspaceId, JSON.stringify(props), userId],
        )
        return r.rows[0].id
      })()
      await makeMovie(client, { entityTypeId: otherTypeId, workspaceId, title: 'Heat', createdBy: userId })
    } finally {
      client.release()
    }

    const out = await store.search(actor, {
      query: 'heat',
      scope: 'entity_instance',
      filters: { entity_type_id: typeId },
    })
    expect(out.data.length).toBe(1)
    expect(out.data[0].entity_type_id).toBe(typeId)
  })

  it('includes user entities in the UNSCOPED cross-primitive search', async () => {
    const client = await pool!.connect()
    try {
      await makeMovie(client, {
        entityTypeId: typeId,
        workspaceId,
        title: 'Interstellar voyage',
        createdBy: userId,
      })
    } finally {
      client.release()
    }

    // No scope → fans out across every primitive AND entity_instances.
    const out = await store.search(actor, { query: 'interstellar' })
    const hit = out.data.find((r) => r.primitive === 'entity_instance')
    expect(hit).toBeDefined()
    expect(hit!.title).toBe('Interstellar voyage')
  })

  it('does not leak another workspace’s entity rows', async () => {
    // A second workspace the actor is NOT a member of, with a matching row.
    const client = await pool!.connect()
    try {
      const otherOwner = await makeUser(client)
      const otherWs = await makeWorkspace(client, otherOwner)
      await addMember(client, otherWs, otherOwner)
      const otherType = await makeMovieType(client, otherWs, otherOwner)
      await makeMovie(client, {
        entityTypeId: otherType,
        workspaceId: otherWs,
        title: 'Secret Movie',
        createdBy: otherOwner,
      })
    } finally {
      client.release()
    }

    const out = await store.search(actor, { query: 'secret', scope: 'entity_instance' })
    expect(out.data.length).toBe(0)
  })

  it('provenance resolves the row as a non-bi-temporal leaf with source_app', async () => {
    // The provenance probe walks every bi-temporal primitive's universal
    // authorship column before reaching entity_instances. `entity_links`
    // gained `created_by_user_id` in the WS-4 authorship backfill
    // migration; on DBs where it hasn't landed, skip rather than fail on
    // unrelated schema drift (the title-search assertions above still run).
    if (!(await hasEntityLinksAuthorship())) return

    const client = await pool!.connect()
    let rowId: string
    try {
      rowId = await makeMovie(client, {
        entityTypeId: typeId,
        workspaceId,
        title: 'Dune',
        createdBy: userId,
        sourceApp: 'chat',
      })
    } finally {
      client.release()
    }

    const result = await provStore.createDbProvenanceStore().provenance(actor, { row_id: rowId })
    expect(result).not.toBeNull()
    expect(result!.data.primitive).toBe('entity_instances')
    expect(result!.data.source_episode).toBeNull()
    expect(result!.data.source_app).toBe('chat')
    expect(result!.data.derived_from).toEqual([])
    expect(result!.data.supersession.superseded_by).toBeNull()
    expect(result!.data.supersession.valid_to).toBeNull()
    expect(result!.data.authorship.created_by_user_id).toBe(userId)
  })
})
