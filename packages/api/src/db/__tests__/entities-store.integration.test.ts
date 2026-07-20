import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AccessContext } from '@use-brian/core'
import pg from 'pg'

/** Build the viewer's AccessContext from the (userId, workspaceId)
 *  pair the test fixtures already track. */
function ctxOf(userId: string, workspaceId: string, assistantId: string = userId): AccessContext {
  return { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
}

/**
 * Integration test for createDbEntitiesStore + the entities schema
 * defined in migration 125 (company-brain WU-1.1). Requires a local
 * PostgreSQL database named `Use Brian` with that migration applied.
 * Skips silently when the DB is unavailable or the migration hasn't
 * been applied yet — WU-1.2 ships alongside WU-1.1 and tests come
 * alive once both land.
 *
 * Fixtures use `kind='project'` / `kind='product'` rather than
 * `'person'`/`'company'`/`'deal'`: WU-1.5 (Q24) blocks direct
 * `createEntity` for the CRM-specialized kinds — those must go through
 * `saveContact`/`saveCompany`/`saveDeal`. CRM-kind entity behavior is
 * covered by `crm-store.integration.test.ts`; this suite exercises the
 * generic (non-CRM) entity path.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM entities LIMIT 1')
      await client.query('SELECT 1 FROM entity_links LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'entities-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'entities-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

describeIf('[COMP:brain/entities-store] entities store (integration)', () => {
  let store: typeof import('../entities-store.js') extends { createDbEntitiesStore: infer T }
    ? T extends (deps: { entityLinks: infer L }) => infer R ? R extends object ? R : never : never
    : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const entitiesMod = await import('../entities-store.js')
    const linksMod = await import('../entity-links-store.js')
    store = entitiesMod.createDbEntitiesStore({ entityLinks: linksMod.createDbEntityLinksStore() })
  })

  describe('CRUD round-trip', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('create + getById round trip', async () => {
      const entity = await store.create({
        kind: 'project',
        displayName: 'Acme Corp',
        canonicalId: 'acme.com',
        workspaceId,
        userId,
        createdByUserId: userId,
        source: 'user',
        attributes: { domain: 'acme.com', industry: 'widgets' },
      })
      expect(entity.kind).toBe('project')
      expect(entity.displayName).toBe('Acme Corp')
      expect(entity.canonicalId).toBe('acme.com')
      expect(entity.attributes).toEqual({ domain: 'acme.com', industry: 'widgets' })
      expect(entity.source).toBe('user')
      expect(entity.sensitivity).toBe('internal')
      expect(entity.workspaceId).toBe(workspaceId)
      expect(entity.userId).toBe(userId)
      expect(entity.createdByUserId).toBe(userId)
      expect(entity.validFrom).toBeInstanceOf(Date)
      expect(entity.validTo).toBeNull()

      const fetched = await store.getById(ctxOf(userId, workspaceId), entity.id)
      expect(fetched?.id).toBe(entity.id)
      expect(fetched?.attributes).toEqual({ domain: 'acme.com', industry: 'widgets' })
    })

    it('findByName is case-insensitive and respects kind filter', async () => {
      await store.create({
        kind: 'project',
        displayName: 'Acme Corp',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      await store.create({
        kind: 'product',
        displayName: 'Acme Person',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })

      const company = await store.findByName(ctxOf(userId, workspaceId), 'acme corp')
      expect(company?.kind).toBe('project')
      expect(company?.displayName).toBe('Acme Corp')

      const onlyPerson = await store.findByName(ctxOf(userId, workspaceId), 'Acme Person', { kind: 'product' })
      expect(onlyPerson?.kind).toBe('product')

      const noMatch = await store.findByName(ctxOf(userId, workspaceId), 'Acme Person', { kind: 'project' })
      expect(noMatch).toBeNull()
    })

    it('findByCanonicalId returns all matches', async () => {
      await store.create({
        kind: 'project', displayName: 'Acme A',
        canonicalId: 'acme.com',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      await store.create({
        kind: 'project', displayName: 'Acme B',
        canonicalId: 'acme.com',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const matches = await store.findByCanonicalId(ctxOf(userId, workspaceId), 'acme.com')
      expect(matches).toHaveLength(2)
      expect(matches.map((e) => e.displayName).sort()).toEqual(['Acme A', 'Acme B'])
    })

    it('listForWorkspace honors kind filter and limit', async () => {
      await store.create({
        kind: 'project', displayName: 'Co A',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      await store.create({
        kind: 'project', displayName: 'Co B',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      await store.create({
        kind: 'product', displayName: 'P A',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })

      const companies = await store.listForWorkspace(ctxOf(userId, workspaceId), { kind: 'project' })
      expect(companies.map((r) => r.displayName).sort()).toEqual(['Co A', 'Co B'])

      const justOne = await store.listForWorkspace(ctxOf(userId, workspaceId), { limit: 1 })
      expect(justOne).toHaveLength(1)
    })

    it('update mutates a subset and bumps updated_at', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Original',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const originalUpdated = entity.updatedAt.getTime()
      await new Promise((r) => setTimeout(r, 10))

      const updated = await store.update(userId, entity.id, {
        displayName: 'Renamed',
        attributes: { ticker: 'ACM' },
      })
      expect(updated?.displayName).toBe('Renamed')
      expect(updated?.attributes).toEqual({ ticker: 'ACM' })
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(originalUpdated)
    })

    it('update returns null for unknown id', async () => {
      const result = await store.update(userId, '00000000-0000-0000-0000-000000000000', {
        displayName: 'never',
      })
      expect(result).toBeNull()
    })

    it('verify stamp lands on the row', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'extracted',
      })
      expect(entity.verifiedByUserId).toBeNull()
      const verified = await store.update(userId, entity.id, {
        verifiedByUserId: userId,
        verifiedAt: new Date(),
      })
      expect(verified?.verifiedByUserId).toBe(userId)
      expect(verified?.verifiedAt).toBeInstanceOf(Date)
    })
  })

  describe('getEntity rollup — identity resolution', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('resolves by name and returns the {entity, summary, embedded} envelope', async () => {
      await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const rollup = await store.getEntity(ctxOf(userId, workspaceId), 'Acme')
      expect(rollup?.entity.displayName).toBe('Acme')
      expect(rollup?.summary).toEqual({
        edge_count: 0,
        memory_count: 0,
        episode_count: 0,
        open_task_count: 0,
        file_count: 0,
        kb_chunk_count: 0,
      })
      expect(rollup?.embedded.edges).toEqual([])
      expect(rollup?.embedded.recent_episodes).toEqual([])
      expect(rollup?.embedded.recent_memory).toEqual([])
      expect(rollup?.embedded.open_tasks).toEqual([])
      expect(rollup?.embedded.files).toEqual([])
      expect(rollup?.followedSupersession).toBeUndefined()
    })

    it('resolves by UUID', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const rollup = await store.getEntity(ctxOf(userId, workspaceId), entity.id)
      expect(rollup?.entity.id).toBe(entity.id)
    })

    it('returns null when not found', async () => {
      const rollup = await store.getEntity(ctxOf(userId, workspaceId), 'Nonexistent')
      expect(rollup).toBeNull()
    })

    it('follows superseded_by by default and records breadcrumb', async () => {
      const newer = await store.create({
        kind: 'project', displayName: 'Acme V2',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const older = await store.create({
        kind: 'project', displayName: 'Acme V1',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      // Stamp older as superseded by newer.
      const client = await pool!.connect()
      try {
        await client.query(
          `UPDATE entities SET superseded_by = $1 WHERE id = $2`,
          [newer.id, older.id],
        )
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId), older.id)
      expect(rollup?.entity.id).toBe(newer.id)
      expect(rollup?.followedSupersession).toEqual({
        fromId: older.id,
        toId: newer.id,
        supersededAt: null,
      })
    })

    it('strictIdentity disables the supersession follow', async () => {
      const newer = await store.create({
        kind: 'project', displayName: 'Acme V2',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const older = await store.create({
        kind: 'project', displayName: 'Acme V1',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        await client.query(
          `UPDATE entities SET superseded_by = $1 WHERE id = $2`,
          [newer.id, older.id],
        )
      } finally {
        client.release()
      }
      const rollup = await store.getEntity(ctxOf(userId, workspaceId), older.id, { strictIdentity: true })
      expect(rollup?.entity.id).toBe(older.id)
      expect(rollup?.followedSupersession).toBeUndefined()
    })

    it('cross-workspace UUID lookup returns null', async () => {
      const client = await pool!.connect()
      let otherWorkspaceId: string
      try {
        otherWorkspaceId = await makeWorkspace(client, userId)
        await addMember(client, otherWorkspaceId, userId)
      } finally {
        client.release()
      }
      const otherEntity = await store.create({
        kind: 'project', displayName: 'Other Acme',
        workspaceId: otherWorkspaceId, userId, createdByUserId: userId, source: 'user',
      })
      // Lookup using the FIRST workspace; must return null because the
      // entity lives in the OTHER workspace.
      const rollup = await store.getEntity(ctxOf(userId, workspaceId), otherEntity.id)
      expect(rollup).toBeNull()
    })
  })

  describe('[COMP:brain/entity-rollup] cross-primitive rollup (WU-1.8)', () => {
    let userId: string
    let workspaceId: string
    let assistantId: string

    async function makeAssistant(client: pg.PoolClient): Promise<string> {
      const r = await client.query(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
         VALUES (gen_random_uuid(), 'rollup-test-asst', $1, $2)
         RETURNING id`,
        [userId, workspaceId],
      )
      return r.rows[0].id
    }

    async function makeMemory(
      client: pg.PoolClient,
      opts: { summary: string; detail?: string; tags?: string[] } = { summary: 'm' },
    ): Promise<string> {
      // workspace_scope_consistency (mig 110): scope='workspace'
      // requires workspace_id NOT NULL (and vice versa).
      // WU-4.2b: viewer projection uses
      // `(assistant_id IS NULL OR assistant_id = viewer.assistant_id)`.
      // Tests build the viewer ctx with the same `assistantId` the
      // row is stamped with, so both rules-followers satisfy the
      // predicate.
      const r = await client.query(
        `INSERT INTO memories (
           assistant_id, user_id, workspace_id, scope, summary, detail, tags, source
         )
         VALUES ($1, $2, $3, 'workspace', $4, $5, $6, 'user')
         RETURNING id`,
        [assistantId, userId, workspaceId, opts.summary, opts.detail ?? null, opts.tags ?? []],
      )
      return r.rows[0].id
    }

    async function makeTask(
      client: pg.PoolClient,
      opts: { title: string; status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived' } = { title: 't' },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO tasks (workspace_id, title, status)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [workspaceId, opts.title, opts.status ?? 'todo'],
      )
      return r.rows[0].id
    }

    async function makeFile(
      client: pg.PoolClient,
      opts: { path: string; name: string; title?: string } = { path: '/f', name: 'f.md' },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO workspace_files (workspace_id, path, name, title, storage_uri)
         VALUES ($1, $2, $3, $4, 'mock://test')
         RETURNING id`,
        [workspaceId, opts.path, opts.name, opts.title ?? null],
      )
      return r.rows[0].id
    }

    async function makeLink(
      client: pg.PoolClient,
      params: {
        sourceKind: string
        sourceId: string
        targetKind: string
        targetId: string
        edgeType: string
      },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO entity_links (
           source_kind, source_id, target_kind, target_id, edge_type,
           workspace_id, user_id, source
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'user')
         RETURNING id`,
        [
          params.sourceKind, params.sourceId, params.targetKind, params.targetId, params.edgeType,
          workspaceId, userId,
        ],
      )
      return r.rows[0].id
    }

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
        assistantId = await makeAssistant(client)
      } finally {
        client.release()
      }
    })

    it('walks memory → entity links and embeds recent_memory', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const memId = await makeMemory(client, { summary: 'Acme prefers email' })
        await makeLink(client, {
          sourceKind: 'memory', sourceId: memId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.memory_count).toBe(1)
      expect(rollup?.embedded.recent_memory).toHaveLength(1)
      const memRow = rollup?.embedded.recent_memory[0] as { summary: string; edgeType: string }
      expect(memRow.summary).toBe('Acme prefers email')
      expect(memRow.edgeType).toBe('mentioned')
    })

    it('open_task_count excludes done/archived tasks; embeds only open ones', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const todoId = await makeTask(client, { title: 'todo task', status: 'todo' })
        const inProgressId = await makeTask(client, { title: 'wip task', status: 'in_progress' })
        const doneId = await makeTask(client, { title: 'done task', status: 'done' })
        const archivedId = await makeTask(client, { title: 'archived task', status: 'archived' })
        for (const tId of [todoId, inProgressId, doneId, archivedId]) {
          await makeLink(client, {
            sourceKind: 'task', sourceId: tId,
            targetKind: 'entity', targetId: entity.id,
            edgeType: 'mentioned',
          })
        }
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.open_task_count).toBe(2)
      expect(rollup?.embedded.open_tasks).toHaveLength(2)
      const titles = (rollup?.embedded.open_tasks as Array<{ title: string }>).map((t) => t.title).sort()
      expect(titles).toEqual(['todo task', 'wip task'])
    })

    it('walks entity → file links (documented_by) and embeds files', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const fileId = await makeFile(client, { path: '/specs/acme.md', name: 'acme.md', title: 'Acme one-pager' })
        await makeLink(client, {
          sourceKind: 'entity', sourceId: entity.id,
          targetKind: 'file', targetId: fileId,
          edgeType: 'documented_by',
        })
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.file_count).toBe(1)
      expect(rollup?.embedded.files).toHaveLength(1)
      const fileRow = rollup?.embedded.files[0] as { name: string; title: string; edgeType: string }
      expect(fileRow.name).toBe('acme.md')
      expect(fileRow.title).toBe('Acme one-pager')
      expect(fileRow.edgeType).toBe('documented_by')
    })

    it('fans out memory + task + file in a single rollup call', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const memId = await makeMemory(client, { summary: 'm' })
        const taskId = await makeTask(client, { title: 't', status: 'todo' })
        const fileId = await makeFile(client, { path: '/f.md', name: 'f.md' })
        await makeLink(client, {
          sourceKind: 'memory', sourceId: memId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        await makeLink(client, {
          sourceKind: 'task', sourceId: taskId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        await makeLink(client, {
          sourceKind: 'entity', sourceId: entity.id,
          targetKind: 'file', targetId: fileId,
          edgeType: 'documented_by',
        })
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.memory_count).toBe(1)
      expect(rollup?.summary.open_task_count).toBe(1)
      expect(rollup?.summary.file_count).toBe(1)
      expect(rollup?.summary.edge_count).toBe(3)
      expect(rollup?.embedded.recent_memory).toHaveLength(1)
      expect(rollup?.embedded.open_tasks).toHaveLength(1)
      expect(rollup?.embedded.files).toHaveLength(1)
    })

    it('kb_chunks count stubs to 0 until WU-3.7 wires the rollup', async () => {
      // The `kb_chunks` table itself ships in mig 132, but the rollup
      // helper stays stubbed until WU-3.7. Episodes are now wired —
      // see the [COMP:retrieval/get-entity] block below.
      await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.kb_chunk_count).toBe(0)
    })

    it('honors edgeLimit', async () => {
      const a = await store.create({
        kind: 'project', displayName: 'A',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        for (let i = 0; i < 5; i++) {
          const memId = await makeMemory(client, { summary: `mem ${i}` })
          await makeLink(client, {
            sourceKind: 'memory', sourceId: memId,
            targetKind: 'entity', targetId: a.id,
            edgeType: 'mentioned',
          })
        }
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'A', { edgeLimit: 2 })
      expect(rollup?.summary.edge_count).toBe(5)
      expect(rollup?.embedded.edges).toHaveLength(2)
    })

    it('asOf in the past sees a link that was retracted at "now"', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      let linkId: string
      let createdAt: Date
      try {
        const memId = await makeMemory(client, { summary: 'old memory' })
        linkId = await makeLink(client, {
          sourceKind: 'memory', sourceId: memId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        const stamp = await client.query(
          `SELECT valid_from AS "validFrom" FROM entity_links WHERE id = $1`,
          [linkId],
        )
        createdAt = stamp.rows[0].validFrom
        // Retract: stamp valid_to + retracted_at to now().
        await client.query(
          `UPDATE entity_links SET valid_to = now(), retracted_at = now(), retracted_reason = 'test'
           WHERE id = $1`,
          [linkId],
        )
      } finally {
        client.release()
      }

      // Default (now): link is retracted, so memory_count = 0.
      const liveRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(liveRollup?.summary.memory_count).toBe(0)
      expect(liveRollup?.embedded.recent_memory).toEqual([])

      // asOf = the link's valid_from instant — retracted_at is "now",
      // so this earlier point predates the retraction. But the helper
      // also gates on `retracted_at IS NULL`, mirroring entity_links'
      // tombstone-exclusion contract, so the row stays hidden. This
      // confirms the bi-temporal predicate runs (the row is filtered
      // through retraction, not through accidentally bypassing
      // valid_from).
      const pastRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme', { asOf: createdAt })
      expect(pastRollup?.summary.memory_count).toBe(0)
    })

    it('returns the full empty envelope when the entity has no links', async () => {
      await store.create({
        kind: 'project', displayName: 'Lonely',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Lonely')
      expect(rollup?.summary).toEqual({
        edge_count: 0,
        memory_count: 0,
        episode_count: 0,
        open_task_count: 0,
        file_count: 0,
        kb_chunk_count: 0,
      })
      expect(rollup?.embedded).toEqual({
        edges: [],
        recent_episodes: [],
        recent_memory: [],
        open_tasks: [],
        files: [],
      })
    })
  })

  describe('[COMP:retrieval/get-entity] WU-5.2 — episodes + primitive bi-temporal', () => {
    let userId: string
    let workspaceId: string
    let assistantId: string

    async function makeAssistant(client: pg.PoolClient): Promise<string> {
      const r = await client.query(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
         VALUES (gen_random_uuid(), 'wu52-test-asst', $1, $2)
         RETURNING id`,
        [userId, workspaceId],
      )
      return r.rows[0].id
    }

    async function makeMemory(
      client: pg.PoolClient,
      opts: { summary: string } = { summary: 'm' },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO memories (
           assistant_id, user_id, workspace_id, scope, summary, source
         )
         VALUES ($1, $2, $3, 'workspace', $4, 'user')
         RETURNING id`,
        [assistantId, userId, workspaceId, opts.summary],
      )
      return r.rows[0].id
    }

    async function makeTask(
      client: pg.PoolClient,
      opts: { title: string; status?: 'todo' | 'in_progress' | 'done' } = { title: 't' },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO tasks (workspace_id, title, status)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [workspaceId, opts.title, opts.status ?? 'todo'],
      )
      return r.rows[0].id
    }

    async function makeFile(
      client: pg.PoolClient,
      opts: { path: string; name: string } = { path: '/f', name: 'f.md' },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO workspace_files (workspace_id, path, name, storage_uri)
         VALUES ($1, $2, $3, 'mock://test')
         RETURNING id`,
        [workspaceId, opts.path, opts.name],
      )
      return r.rows[0].id
    }

    async function makeEpisode(
      client: pg.PoolClient,
      opts: { sourceKind?: string; summary?: string; sensitivity?: string } = {},
    ): Promise<{ id: string; ingestedAt: Date }> {
      const r = await client.query(
        `INSERT INTO episodes (
           source_kind, source_ref, occurred_at,
           workspace_id, user_id, created_by_user_id,
           summary_text, sensitivity
         )
         VALUES ($1, '{}'::jsonb, now(), $2, $3, $4, $5, $6)
         RETURNING id, ingested_at AS "ingestedAt"`,
        [
          opts.sourceKind ?? 'chat',
          workspaceId,
          userId,
          userId,
          opts.summary ?? null,
          opts.sensitivity ?? 'internal',
        ],
      )
      return { id: r.rows[0].id, ingestedAt: r.rows[0].ingestedAt }
    }

    async function makeLink(
      client: pg.PoolClient,
      params: {
        sourceKind: string; sourceId: string
        targetKind: string; targetId: string
        edgeType: string
      },
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO entity_links (
           source_kind, source_id, target_kind, target_id, edge_type,
           workspace_id, user_id, source
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'user')
         RETURNING id`,
        [
          params.sourceKind, params.sourceId, params.targetKind, params.targetId, params.edgeType,
          workspaceId, userId,
        ],
      )
      return r.rows[0].id
    }

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
        assistantId = await makeAssistant(client)
      } finally {
        client.release()
      }
    })

    it('walks episode → entity links and embeds recent_episodes', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      let episodeId: string
      try {
        const ep = await makeEpisode(client, { summary: 'Acme call notes' })
        episodeId = ep.id
        await makeLink(client, {
          sourceKind: 'episode', sourceId: episodeId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.episode_count).toBe(1)
      expect(rollup?.embedded.recent_episodes).toHaveLength(1)
      const epRow = rollup?.embedded.recent_episodes[0] as {
        id: string; sourceKind: string; summaryText: string | null; edgeType: string
      }
      expect(epRow.id).toBe(episodeId)
      expect(epRow.sourceKind).toBe('chat')
      expect(epRow.summaryText).toBe('Acme call notes')
      expect(epRow.edgeType).toBe('mentioned')
    })

    it('asOf in the past hides an episode whose ingested_at is in the future of asOf', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      let futureIngestedAt: Date
      try {
        const ep = await makeEpisode(client)
        await makeLink(client, {
          sourceKind: 'episode', sourceId: ep.id,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        // Forward-date the episode's ingested_at past "now" so we can
        // exercise the `e.ingested_at <= asOf` predicate independently
        // of the link's valid_from. Real-world ingested_at is auto-now;
        // this is a test-only nudge.
        const r = await client.query(
          `UPDATE episodes
              SET ingested_at = now() + interval '1 hour'
            WHERE id = $1
            RETURNING ingested_at AS "ingestedAt"`,
          [ep.id],
        )
        futureIngestedAt = r.rows[0].ingestedAt
      } finally {
        client.release()
      }

      // Default asOf = now < ingested_at → episode hidden by primitive
      // (ingested_at) predicate even though the link is valid now.
      const liveRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(liveRollup?.summary.episode_count).toBe(0)
      expect(liveRollup?.embedded.recent_episodes).toEqual([])

      // asOf > ingested_at → episode visible.
      const futureRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme', {
        asOf: new Date(futureIngestedAt.getTime() + 60_000),
      })
      expect(futureRollup?.summary.episode_count).toBe(1)
      expect(futureRollup?.embedded.recent_episodes).toHaveLength(1)
    })

    it('memory whose primitive row is retracted is hidden by the primitive-side predicate', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      let linkValidFrom: Date
      try {
        const memId = await makeMemory(client, { summary: 'Acme prefers email' })
        const linkId = await makeLink(client, {
          sourceKind: 'memory', sourceId: memId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        const stamp = await client.query(
          `SELECT valid_from AS "validFrom" FROM entity_links WHERE id = $1`,
          [linkId],
        )
        linkValidFrom = stamp.rows[0].validFrom
        // Retract the MEMORY row (not the link). Link stays good.
        await client.query(
          `UPDATE memories
              SET valid_to = now(), retracted_at = now(), retracted_reason = 'test'
            WHERE id = $1`,
          [memId],
        )
      } finally {
        client.release()
      }

      // Default (now): primitive predicate gates `retracted_at IS NULL`,
      // so the memory is hidden regardless of `valid_to > asOf`.
      const liveRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(liveRollup?.summary.memory_count).toBe(0)
      expect(liveRollup?.embedded.recent_memory).toEqual([])

      // asOf = link's own valid_from. The retracted_at gate still
      // hides the row — symmetric to the link-side test in the WU-1.8
      // block. Confirms the primitive predicate is composed with the
      // link predicate, not bypassed.
      const pastRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme', { asOf: linkValidFrom })
      expect(pastRollup?.summary.memory_count).toBe(0)
    })

    it('memory whose valid_to is closed (without retraction) is hidden by the primitive-side predicate', async () => {
      // Sets memory.valid_to without touching retracted_at — proves the
      // `valid_to > now` branch of the primitive predicate runs
      // independently of the `retracted_at IS NULL` gate. (asOf
      // time-travel composition is covered by the existing link-side
      // asOf test in the WU-1.8 block and by the episode `ingested_at`
      // asOf test above. Replicating asOf time-travel here is brittle:
      // pg timestamptz has microsecond precision, JS Date has only
      // millisecond — round-tripping the primitive's own valid_from
      // can land before the entity's valid_from and break entity
      // resolution.)
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const memId = await makeMemory(client, { summary: 'Acme prefers slack' })
        await makeLink(client, {
          sourceKind: 'memory', sourceId: memId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        // Close the memory's validity window WITHOUT retraction —
        // simulates a clean supersession on the primitive side.
        await client.query(`UPDATE memories SET valid_to = now() WHERE id = $1`, [memId])
      } finally {
        client.release()
      }

      const liveRollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(liveRollup?.summary.memory_count).toBe(0)
      expect(liveRollup?.embedded.recent_memory).toEqual([])
    })

    it('task whose primitive row is retracted is hidden (status filter alone would have shown it)', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const taskId = await makeTask(client, { title: 'Open task', status: 'todo' })
        await makeLink(client, {
          sourceKind: 'task', sourceId: taskId,
          targetKind: 'entity', targetId: entity.id,
          edgeType: 'mentioned',
        })
        // Status is 'todo' → would pass the open-task filter. Retract
        // the row to prove the bi-temporal gate runs alongside it.
        await client.query(
          `UPDATE tasks SET valid_to = now(), retracted_at = now(), retracted_reason = 'test'
           WHERE id = $1`,
          [taskId],
        )
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.open_task_count).toBe(0)
      expect(rollup?.embedded.open_tasks).toEqual([])
    })

    it('file whose primitive row is retracted is hidden by the primitive-side predicate', async () => {
      const entity = await store.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const client = await pool!.connect()
      try {
        const fileId = await makeFile(client, { path: '/specs/acme.md', name: 'acme.md' })
        await makeLink(client, {
          sourceKind: 'entity', sourceId: entity.id,
          targetKind: 'file', targetId: fileId,
          edgeType: 'documented_by',
        })
        await client.query(
          `UPDATE workspace_files
              SET valid_to = now(), retracted_at = now(), retracted_reason = 'test'
            WHERE id = $1`,
          [fileId],
        )
      } finally {
        client.release()
      }

      const rollup = await store.getEntity(ctxOf(userId, workspaceId, assistantId), 'Acme')
      expect(rollup?.summary.file_count).toBe(0)
      expect(rollup?.embedded.files).toEqual([])
    })
  })
})
