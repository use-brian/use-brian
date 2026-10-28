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
 * PostgreSQL database named `sidanclaw` with that migration applied.
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
  const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 })
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


  describe('real merged UUID resolution', () => {
    const bornAt = new Date('2020-01-01T00:00:00Z')
    const firstMerge = new Date('2021-01-01T00:00:00Z')
    const secondMerge = new Date('2022-01-01T00:00:00Z')
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally { client.release() }
    })

    async function entity(label: string, targetWorkspace = workspaceId) {
      const row = await store.create({ kind: 'project', displayName: label,
        workspaceId: targetWorkspace, userId, createdByUserId: userId, source: 'user' })
      // Deterministic historical boundaries, without mocking any reader.
      await pool!.query('UPDATE entities SET valid_from=$2 WHERE id=$1', [row.id, bornAt])
      return row
    }

    async function merge(survivingId: string, mergedId: string, at: Date) {
      const { mergeEntities } = await import('@use-brian/core')
      const { createEntityMergeStore } = await import('../entity-merge-store.js')
      return mergeEntities({ workspaceId, survivingId, mergedId, actorUserId: userId,
        mode: 'survivor-wins', cascade: false }, { repo: createEntityMergeStore(), clock: () => at })
    }

    // Malformed/withdrawn-chain controls may use synthetic links; positive
    // retirement and transitive recovery below always use real merge code.
    async function syntheticChain(length: number) {
      const rows = []
      for (let i = 0; i < length; i++) rows.push(await entity(`Fictional version ${i}`))
      for (let i = 0; i + 1 < rows.length; i++) {
        await pool!.query('UPDATE entities SET valid_to=$2,superseded_by=$3 WHERE id=$1',
          [rows[i]!.id, firstMerge, rows[i + 1]!.id])
      }
      return rows
    }

    it('resolves a truly retired UUID after the actual merge and keeps ordinary temporal reads unchanged', async () => {
      const older = await entity('Fictional original')
      const newer = await entity('Fictional survivor')
      const { queryWithRLS } = await import('../client.js')
      const role = await queryWithRLS<{ superuser: boolean; bypass: boolean; owner: boolean }>(userId,
        `SELECT r.rolsuper AS superuser,r.rolbypassrls AS bypass,
          r.oid=(SELECT relowner FROM pg_class WHERE oid='entities'::regclass) AS owner
         FROM pg_roles r WHERE r.rolname=current_user`)
      expect(role.rows[0]).toEqual({ superuser: false, bypass: false, owner: false })
      await merge(newer.id, older.id, firstMerge)
      const retired = await pool!.query('SELECT valid_to,superseded_by FROM entities WHERE id=$1', [older.id])
      expect(retired.rows[0]).toEqual({ valid_to: firstMerge, superseded_by: newer.id })
      expect(await store.getById(ctxOf(userId, workspaceId), older.id)).toBeNull()
      // Merge preserves the old name as a survivor alias; name discovery stays live.
      expect((await store.findByName(ctxOf(userId, workspaceId), older.displayName))?.id).toBe(newer.id)
      const result = await store.getEntity(ctxOf(userId, workspaceId), older.id)
      expect(result?.entity.id).toBe(newer.id)
      expect(result?.followedSupersession).toEqual({ fromId: older.id, toId: newer.id, supersededAt: firstMerge })
    })

    it('follows actual transitive merges and reports the final predecessor breadcrumb', async () => {
      const a = await entity('Fictional first')
      const b = await entity('Fictional second')
      const c = await entity('Fictional final')
      await merge(b.id, a.id, firstMerge)
      await merge(c.id, b.id, secondMerge)
      const result = await store.getEntity(ctxOf(userId, workspaceId), a.id)
      expect(result?.entity.id).toBe(c.id)
      expect(result?.followedSupersession).toEqual({ fromId: b.id, toId: c.id, supersededAt: secondMerge })
    })

    it('returns the effective identity before, between and after actual merges', async () => {
      const a = await entity('Fictional historical first')
      const b = await entity('Fictional historical middle')
      const c = await entity('Fictional historical final')
      await merge(b.id, a.id, firstMerge)
      await merge(c.id, b.id, secondMerge)
      const before = await store.getEntity(ctxOf(userId, workspaceId), a.id, { asOf: new Date('2020-06-01T00:00:00Z') })
      expect(before?.entity.id).toBe(a.id)
      expect(before?.followedSupersession).toBeUndefined()
      const between = await store.getEntity(ctxOf(userId, workspaceId), a.id, { asOf: new Date('2021-06-01T00:00:00Z') })
      expect(between?.entity.id).toBe(b.id)
      expect(between?.followedSupersession).toEqual({ fromId: a.id, toId: b.id, supersededAt: firstMerge })
      const after = await store.getEntity(ctxOf(userId, workspaceId), a.id, { asOf: new Date('2023-01-01T00:00:00Z') })
      expect(after?.entity.id).toBe(c.id)
    })

    it('keeps strict identity on the authorized retired predecessor without following it', async () => {
      const a = await entity('Fictional strict original')
      const b = await entity('Fictional strict survivor')
      await merge(b.id, a.id, firstMerge)
      const result = await store.getEntity(ctxOf(userId, workspaceId), a.id, { strictIdentity: true })
      expect(result?.entity.id).toBe(a.id)
      expect(result?.followedSupersession).toBeUndefined()
    })

    async function fractionalMerge() {
      const a = await entity('Fictional fractional predecessor')
      const b = await entity('Fictional fractional survivor')
      await merge(b.id, a.id, firstMerge)
      // PostgreSQL retirement timestamps can retain microseconds that JS Date
      // cannot represent. Keep the real merge and stamp an exact fixture time.
      await pool!.query('UPDATE entities SET valid_to=$2::timestamptz WHERE id=$1',
        [a.id, '2021-01-01T00:00:00.123456Z'])
      const stored = await pool!.query<{ exact: boolean }>(
        "SELECT valid_to='2021-01-01T00:00:00.123456Z'::timestamptz AS exact FROM entities WHERE id=$1", [a.id])
      expect(stored.rows[0]?.exact).toBe(true)
      return { a, b }
    }

    it.each(['2021-01-01T00:00:00.122Z', '2021-01-01T00:00:00.123Z'])(
      'preserves the predecessor before a fractional retirement at asOf %s', async instant => {
        const { a } = await fractionalMerge()
        const result = await store.getEntity(ctxOf(userId, workspaceId), a.id, { asOf: new Date(instant) })
        expect(result?.entity.id).toBe(a.id)
        expect(result?.followedSupersession).toBeUndefined()
      },
    )

    it('keeps strict identity on a predecessor with a fractional retirement timestamp', async () => {
      const { a } = await fractionalMerge()
      const result = await store.getEntity(ctxOf(userId, workspaceId), a.id, { strictIdentity: true })
      expect(result?.entity.id).toBe(a.id)
      expect(result?.followedSupersession).toBeUndefined()
    })

    it('follows a fractional retirement only after it is effective', async () => {
      const { a, b } = await fractionalMerge()
      const result = await store.getEntity(ctxOf(userId, workspaceId), a.id,
        { asOf: new Date('2021-01-01T00:00:00.124Z') })
      expect(result?.entity.id).toBe(b.id)
      expect(result?.followedSupersession).toEqual({ fromId: a.id, toId: b.id,
        supersededAt: new Date('2021-01-01T00:00:00.123Z') })
    })

    it.each([0, 1, 2])('refuses an invisible chain row at position %s even when other rows remain visible', async position => {
      const rows = await syntheticChain(3)
      await pool!.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1", [rows[position]!.id])
      const viewer = { ...ctxOf(userId, workspaceId), clearance: 'internal' as const }
      if (position !== 2) expect((await store.getById(viewer, rows[2]!.id))?.id).toBe(rows[2]!.id)
      expect(await store.getEntity(viewer, rows[0]!.id)).toBeNull()
    })

    it.each([
      ['retracted', 0], ['retracted', 1], ['retracted', 2],
      ['held', 0], ['held', 1], ['held', 2],
    ] as const)('refuses a %s row at chain position %s', async (state, position) => {
      const rows = await syntheticChain(3)
      if (state === 'retracted') await pool!.query("UPDATE entities SET retracted_at=now(),retracted_reason='Fictional correction' WHERE id=$1", [rows[position]!.id])
      else await pool!.query('UPDATE entities SET scope_held=true WHERE id=$1', [rows[position]!.id])
      expect(await store.getEntity(ctxOf(userId, workspaceId), rows[0]!.id)).toBeNull()
    })

    it('refuses a cross-workspace successor even when the actor belongs to both workspaces', async () => {
      const client = await pool!.connect()
      let otherWorkspace: string
      try { otherWorkspace = await makeWorkspace(client, userId); await addMember(client, otherWorkspace, userId) }
      finally { client.release() }
      const a = await entity('Fictional local original')
      const b = await entity('Fictional foreign successor', otherWorkspace)
      await pool!.query('UPDATE entities SET valid_to=$2,superseded_by=$3 WHERE id=$1', [a.id, firstMerge, b.id])
      expect(await store.getEntity(ctxOf(userId, workspaceId), a.id)).toBeNull()
    })

    it('refuses an expired terminal target without a successor', async () => {
      const rows = await syntheticChain(2)
      await pool!.query('UPDATE entities SET valid_to=$2 WHERE id=$1', [rows[1]!.id, secondMerge])
      expect(await store.getEntity(ctxOf(userId, workspaceId), rows[0]!.id)).toBeNull()
    })

    it('refuses cyclic malformed links without returning an intermediate row', async () => {
      const rows = await syntheticChain(2)
      await pool!.query('UPDATE entities SET valid_to=$2,superseded_by=$3 WHERE id=$1', [rows[1]!.id, secondMerge, rows[0]!.id])
      expect(await store.getEntity(ctxOf(userId, workspaceId), rows[0]!.id)).toBeNull()
    })

    it('accepts 64 links and refuses a chain exceeding that bound', async () => {
      const rows = await syntheticChain(66)
      expect((await store.getEntity(ctxOf(userId, workspaceId), rows[1]!.id))?.entity.id).toBe(rows[65]!.id)
      expect(await store.getEntity(ctxOf(userId, workspaceId), rows[0]!.id)).toBeNull()
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
