import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AccessContext } from '@sidanclaw/core'
import pg from 'pg'

function ctxOf(userId: string, workspaceId: string, assistantId: string = userId): AccessContext {
  return { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
}

/**
 * Integration test for createDbEntityLinksStore + the entity_links
 * schema defined in migration 126 (company-brain WU-1.1). Skips when
 * the DB or migration isn't available — paired with WU-1.2's parallel
 * dispatch with WU-1.1.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
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
     VALUES (gen_random_uuid(), 'test', 'links-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'links-test-ws', 'test', $1, false)
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

describeIf('[COMP:brain/entity-links-store] entity_links store (integration)', () => {
  let store: typeof import('../entity-links-store.js') extends {
    createDbEntityLinksStore: infer T
  }
    ? T extends () => infer R ? R : never
    : never
  let entitiesStore: typeof import('../entities-store.js') extends {
    createDbEntitiesStore: infer T
  }
    ? T extends (deps: { entityLinks: infer L }) => infer R ? R : never
    : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const linksMod = await import('../entity-links-store.js')
    const entitiesMod = await import('../entities-store.js')
    store = linksMod.createDbEntityLinksStore()
    entitiesStore = entitiesMod.createDbEntitiesStore({ entityLinks: store })
  })

  describe('CRUD + walks', () => {
    let userId: string
    let workspaceId: string
    let acme: { id: string }
    let jordan: { id: string }

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
      // WU-1.5 (Q24): direct createEntity for 'person'/'company'/'deal'
      // is blocked — these fixtures use the non-CRM kinds. The
      // entity-links store does not enforce edge endpoint-kind
      // constraints (that is `validateEdge`'s job at write sites), so
      // 'project'/'product' anchors exercise the walks identically.
      acme = await entitiesStore.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      jordan = await entitiesStore.create({
        kind: 'product', displayName: 'Jordan',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
    })

    it('create + getById round trip', async () => {
      const link = await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
        attributes: { role: 'founder' },
      })
      expect(link.edgeType).toBe('works_at')
      expect(link.attributes).toEqual({ role: 'founder' })
      expect(link.validFrom).toBeInstanceOf(Date)
      expect(link.validTo).toBeNull()
      expect(link.retractedAt).toBeNull()

      const fetched = await store.getById(ctxOf(userId, workspaceId), link.id)
      expect(fetched?.id).toBe(link.id)
      expect(fetched?.sourceId).toBe(jordan.id)
      expect(fetched?.targetId).toBe(acme.id)
    })

    it('rejects when both userId and assistantId are missing', async () => {
      await expect(
        store.create({
          sourceKind: 'entity', sourceId: jordan.id,
          targetKind: 'entity', targetId: acme.id,
          edgeType: 'works_at',
          workspaceId, source: 'user',
        }),
      ).rejects.toThrow(/at least one of userId/i)
    })

    it('walkOutbound returns links FROM the source', async () => {
      await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      const out = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', jordan.id)
      expect(out).toHaveLength(1)
      expect(out[0].edgeType).toBe('works_at')

      const wrongDir = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', acme.id)
      expect(wrongDir).toHaveLength(0)
    })

    it('walkInbound returns links TO the target', async () => {
      await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      const inb = await store.walkInbound(ctxOf(userId, workspaceId), 'entity', acme.id)
      expect(inb).toHaveLength(1)
      expect(inb[0].sourceId).toBe(jordan.id)
    })

    it('edgeTypes filter narrows the walk', async () => {
      await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'discussed_with',
        workspaceId, userId, source: 'user',
      })
      const onlyWorksAt = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', jordan.id, {
        edgeTypes: ['works_at'],
      })
      expect(onlyWorksAt.map((e) => e.edgeType)).toEqual(['works_at'])
    })

    it('countForEntity counts both endpoints, ignores retracted', async () => {
      const l1 = await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      await store.create({
        sourceKind: 'memory', sourceId: '00000000-0000-0000-0000-000000000001',
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'mentioned',
        workspaceId, userId, source: 'user',
      })
      expect(await store.countForEntity(ctxOf(userId, workspaceId), acme.id)).toBe(2)
      expect(await store.countForEntity(ctxOf(userId, workspaceId), jordan.id)).toBe(1)

      await store.retract(userId, l1.id, 'reclassified')
      expect(await store.countForEntity(ctxOf(userId, workspaceId), acme.id)).toBe(1)
    })

    it('retract closes the bi-temporal window and excludes from walks', async () => {
      const link = await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      const retracted = await store.retract(userId, link.id, 'left the company')
      expect(retracted?.retractedAt).toBeInstanceOf(Date)
      expect(retracted?.retractedReason).toBe('left the company')
      expect(retracted?.validTo).toBeInstanceOf(Date)

      const out = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', jordan.id)
      expect(out).toHaveLength(0)
    })

    it('retract on an already-retracted row returns null', async () => {
      const link = await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      await store.retract(userId, link.id, 'first')
      const again = await store.retract(userId, link.id, 'second')
      expect(again).toBeNull()
    })

    it('asOf filter excludes rows whose valid_to is past asOf', async () => {
      const link = await store.create({
        sourceKind: 'entity', sourceId: jordan.id,
        targetKind: 'entity', targetId: acme.id,
        edgeType: 'works_at',
        workspaceId, userId, source: 'user',
      })
      await new Promise((r) => setTimeout(r, 10))
      const before = new Date()
      await new Promise((r) => setTimeout(r, 10))
      const client = await pool!.connect()
      try {
        await client.query(`UPDATE entity_links SET valid_to = now() WHERE id = $1`, [link.id])
      } finally {
        client.release()
      }
      const past = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', jordan.id, { asOf: before })
      expect(past.map((e) => e.id)).toContain(link.id)
      const nowState = await store.walkOutbound(ctxOf(userId, workspaceId), 'entity', jordan.id)
      expect(nowState.map((e) => e.id)).not.toContain(link.id)
    })
  })

  describe('getEntity rollup composes edge data', () => {
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

    it('surfaces edges and edge_count in the entity rollup', async () => {
      const acme = await entitiesStore.create({
        kind: 'project', displayName: 'Acme',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      const jordan = await entitiesStore.create({
        kind: 'product', displayName: 'Jordan',
        workspaceId, userId, createdByUserId: userId, source: 'user',
      })
      await store.create({
        sourceKind: 'entity', sourceId: acme.id,
        targetKind: 'entity', targetId: jordan.id,
        edgeType: 'discussed_with',
        workspaceId, userId, source: 'user',
      })
      const rollup = await entitiesStore.getEntity(ctxOf(userId, workspaceId), 'Acme')
      expect(rollup?.summary.edge_count).toBe(1)
      expect(rollup?.embedded.edges).toHaveLength(1)
      expect(rollup?.embedded.edges[0].edgeType).toBe('discussed_with')
    })
  })
})
