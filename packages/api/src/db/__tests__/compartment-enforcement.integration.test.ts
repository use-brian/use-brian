import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import type { AccessContext, RetrievalActor } from '@sidanclaw/core'

/**
 * [COMP:brain/compartment-enforcement] — compartment axis end-to-end read-gate proof.
 *
 * Proves the fifth permission axis (the non-hierarchical MLS "compartment"
 * category set) actually ENFORCES on every read surface, against the real
 * `buildAccessPredicate` superset clause (`row.compartments <@ $grant`) and the
 * real `resolveReadCompartmentsSystem` (`member ∩ assistant`) resolver.
 *
 * Design: rows are seeded workspace-shared for a single user (user_id set,
 * assistant_id NULL) so the visibility-double + sensitivity always pass and the
 * ONLY differentiator is the compartment clause — exactly how
 * store-permission-coverage isolates the sensitivity axis. The effective grant
 * is varied on `AccessContext.compartments` directly for the predicate
 * assertions; a separate block exercises `resolveReadCompartmentsSystem` so the
 * (member, assistant) → effective-grant resolution is proven and then fed back
 * into the predicate, closing the chain.
 *
 * Three read paths are covered: `getMemoryById` (bare `query()`,
 * predicate-only — role-independent, works under a local superuser),
 * `getDealById` (RLS + predicate), and `retrieval-store.search()` (the
 * `searchBrain`/aggregate retrieval surface, scope `kb_chunk`).
 *
 * Acceptance scenario (docs/plans/compartment-axis.md): in a workspace with
 * {research, finance}, a sales-only grant reads NEITHER the research nor the
 * finance row but DOES read the untagged control; a universe/admin grant reads
 * all; a confidential research row stays hidden from a public-clearance viewer
 * via the SENSITIVITY gate independent of compartments; untagged rows are open.
 *
 * Requires a local `sidanclaw` PostgreSQL with migration 243 applied. Skips
 * silently otherwise (the canConnect probe checks the compartment columns).
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT compartments FROM memories LIMIT 1')
      await client.query('SELECT compartments FROM deals LIMIT 1')
      await client.query('SELECT compartments FROM kb_chunks LIMIT 1')
      await client.query('SELECT compartments, default_compartments FROM assistants LIMIT 1')
      await client.query('SELECT compartments FROM workspace_members LIMIT 1')
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

type Sensitivity = 'public' | 'internal' | 'confidential'

// ── Seed helpers ────────────────────────────────────────────────────

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'comp-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'comp-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
  clearance: Sensitivity,
  compartments: string[] | null,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, clearance, compartments)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [workspaceId, userId, role, clearance, compartments],
  )
}

async function makeAssistant(
  client: pg.PoolClient,
  ownerId: string,
  workspaceId: string,
  opts: { compartments: string[] | null; defaultCompartments: string[] },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind, clearance, compartments, default_compartments)
     VALUES (gen_random_uuid(), 'comp-test-assistant', $1, $2, 'standard', 'confidential', $3, $4)
     RETURNING id`,
    [ownerId, workspaceId, opts.compartments, opts.defaultCompartments],
  )
  return r.rows[0].id
}

// Rows are workspace-shared (user_id set, assistant_id NULL) so the
// visibility-double always passes for the single test user — the compartment
// array is the only gate. sensitivity defaults to 'internal' (viewers read at
// 'confidential') except the explicit confidential-research canary.

async function seedMemory(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  compartments: string[],
  sensitivity: Sensitivity = 'internal',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO memories (
       assistant_id, user_id, workspace_id, scope, tags, summary, detail,
       confidence, sensitivity, source, created_by_user_id, compartments
     ) VALUES (
       NULL, $1, $2, 'workspace', ARRAY['comp-test'],
       'compcanaryword memory', NULL, 0.9, $3, 'user', $1, $4
     ) RETURNING id`,
    [userId, ws, sensitivity, compartments],
  )
  return r.rows[0].id
}

async function seedDeal(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  compartments: string[],
  sensitivity: Sensitivity = 'internal',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO deals (
       workspace_id, stage, external_ref, sensitivity,
       user_id, assistant_id, source, created_by_user_id, compartments
     ) VALUES (
       $1, 'lead', '{}'::jsonb, $3, $2, NULL, 'user', $2, $4
     ) RETURNING id`,
    [ws, userId, sensitivity, compartments],
  )
  return r.rows[0].id
}

async function seedKbChunk(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  compartments: string[],
  sensitivity: Sensitivity = 'internal',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO kb_chunks (
       chunk_text, sensitivity, user_id, assistant_id, workspace_id,
       created_by_user_id, source, compartments
     ) VALUES (
       'compcanaryword kb chunk', $3, $2, NULL, $1, $2, 'kb_sync', $4
     ) RETURNING id`,
    [ws, userId, sensitivity, compartments],
  )
  return r.rows[0].id
}

type Seed = {
  workspaceA: string
  userA1: string // owner (universe member)
  salesUser: string // role=member, compartments=['sales']
  researchAssistant: string // compartments=['research'], default=['research']
  memory: { research: string; finance: string; untagged: string; confidentialResearch: string }
  deal: { research: string; finance: string; untagged: string }
  kbChunk: { research: string; finance: string; untagged: string }
}

async function seedFixture(client: pg.PoolClient): Promise<Seed> {
  const userA1 = await makeUser(client)
  const workspaceA = await makeWorkspace(client, userA1)
  await addMember(client, workspaceA, userA1, 'owner', 'confidential', null)

  const salesUser = await makeUser(client)
  await addMember(client, workspaceA, salesUser, 'member', 'confidential', ['sales'])

  const researchAssistant = await makeAssistant(client, userA1, workspaceA, {
    compartments: ['research'],
    defaultCompartments: ['research'],
  })

  return {
    workspaceA,
    userA1,
    salesUser,
    researchAssistant,
    memory: {
      research: await seedMemory(client, workspaceA, userA1, ['research']),
      finance: await seedMemory(client, workspaceA, userA1, ['finance']),
      untagged: await seedMemory(client, workspaceA, userA1, []),
      confidentialResearch: await seedMemory(client, workspaceA, userA1, ['research'], 'confidential'),
    },
    deal: {
      research: await seedDeal(client, workspaceA, userA1, ['research']),
      finance: await seedDeal(client, workspaceA, userA1, ['finance']),
      untagged: await seedDeal(client, workspaceA, userA1, []),
    },
    kbChunk: {
      research: await seedKbChunk(client, workspaceA, userA1, ['research']),
      finance: await seedKbChunk(client, workspaceA, userA1, ['finance']),
      untagged: await seedKbChunk(client, workspaceA, userA1, []),
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describeIf('[COMP:brain/compartment-enforcement] compartment read-gate', () => {
  let seed: Seed
  let memories: typeof import('../memories.js')
  let crm: typeof import('../crm.js')
  let retrieval: typeof import('../retrieval-store.js')
  let workspaceStore: typeof import('../workspace-store.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
    crm = await import('../crm.js')
    retrieval = await import('../retrieval-store.js')
    workspaceStore = await import('../workspace-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      seed = await seedFixture(client)
    } finally {
      client.release()
    }
  })

  // Viewer in workspace A, scope (userA1, assistant_id NULL rows), at a finite
  // or universe compartment grant. clearance stays 'confidential' so the
  // sensitivity axis never interferes (except the explicit sensitivity block).
  function ctx(compartments: string[] | null, clearance: Sensitivity = 'confidential'): AccessContext {
    return {
      workspaceId: seed.workspaceA,
      userId: seed.userA1,
      assistantId: seed.researchAssistant,
      assistantKind: 'standard',
      clearance,
      compartments,
    }
  }

  describe('memories — getMemoryById (bare-query predicate path)', () => {
    it('a sales-only grant cannot read the research or finance row', async () => {
      expect(await memories.getMemoryById(ctx(['sales']), seed.memory.research)).toBeNull()
      expect(await memories.getMemoryById(ctx(['sales']), seed.memory.finance)).toBeNull()
    })
    it('a sales-only grant still reads the untagged control (MLS-open)', async () => {
      expect(await memories.getMemoryById(ctx(['sales']), seed.memory.untagged)).not.toBeNull()
    })
    it('a universe grant (null) reads every row', async () => {
      expect(await memories.getMemoryById(ctx(null), seed.memory.research)).not.toBeNull()
      expect(await memories.getMemoryById(ctx(null), seed.memory.finance)).not.toBeNull()
      expect(await memories.getMemoryById(ctx(null), seed.memory.untagged)).not.toBeNull()
    })
    it('a research grant reads research + untagged but NOT finance', async () => {
      expect(await memories.getMemoryById(ctx(['research']), seed.memory.research)).not.toBeNull()
      expect(await memories.getMemoryById(ctx(['research']), seed.memory.untagged)).not.toBeNull()
      expect(await memories.getMemoryById(ctx(['research']), seed.memory.finance)).toBeNull()
    })
    it('an empty grant ([]) reads ONLY untagged rows', async () => {
      expect(await memories.getMemoryById(ctx([]), seed.memory.untagged)).not.toBeNull()
      expect(await memories.getMemoryById(ctx([]), seed.memory.research)).toBeNull()
      expect(await memories.getMemoryById(ctx([]), seed.memory.finance)).toBeNull()
    })
  })

  describe('deals — getDealById (RLS + predicate path)', () => {
    it('a sales-only grant cannot read the finance deal but reads the untagged control', async () => {
      expect(await crm.getDealById(ctx(['sales']), seed.deal.finance)).toBeNull()
      expect(await crm.getDealById(ctx(['sales']), seed.deal.untagged)).not.toBeNull()
    })
    it('a finance grant reads the finance deal', async () => {
      expect(await crm.getDealById(ctx(['finance']), seed.deal.finance)).not.toBeNull()
    })
    it('a universe grant reads every deal', async () => {
      expect(await crm.getDealById(ctx(null), seed.deal.research)).not.toBeNull()
      expect(await crm.getDealById(ctx(null), seed.deal.finance)).not.toBeNull()
    })
  })

  describe('retrieval surface — search() scope=kb_chunk', () => {
    function actor(compartments: string[] | null): RetrievalActor {
      return {
        workspaceId: seed.workspaceA,
        userId: seed.userA1,
        assistantId: seed.researchAssistant,
        assistantKind: 'standard',
        clearance: 'confidential',
        compartments,
      }
    }
    async function searchIds(a: RetrievalActor): Promise<string[]> {
      const r = await retrieval.search(a, { query: 'compcanaryword', scope: 'kb_chunk' })
      return r.data.map((row) => row.row_id)
    }

    it('a sales-only grant sees neither research nor finance chunks, only the untagged control', async () => {
      const ids = await searchIds(actor(['sales']))
      expect(ids).not.toContain(seed.kbChunk.research)
      expect(ids).not.toContain(seed.kbChunk.finance)
      expect(ids).toContain(seed.kbChunk.untagged)
    })
    it('a universe grant sees all chunks', async () => {
      const ids = await searchIds(actor(null))
      expect(ids).toContain(seed.kbChunk.research)
      expect(ids).toContain(seed.kbChunk.finance)
      expect(ids).toContain(seed.kbChunk.untagged)
    })
  })

  describe('sensitivity composes independently (AND, never collapsed)', () => {
    it('a research grant at public clearance cannot read the confidential research row (sensitivity gate)', async () => {
      expect(await memories.getMemoryById(ctx(['research'], 'public'), seed.memory.confidentialResearch)).toBeNull()
    })
    it('a research grant at confidential clearance reads the confidential research row', async () => {
      expect(
        await memories.getMemoryById(ctx(['research'], 'confidential'), seed.memory.confidentialResearch),
      ).not.toBeNull()
    })
  })

  describe('resolver chain — resolveReadCompartmentsSystem (member ∩ assistant)', () => {
    it('sales-only member ∩ research assistant → empty grant (sees only untagged)', async () => {
      const grant = await workspaceStore.resolveReadCompartmentsSystem(
        seed.salesUser,
        seed.workspaceA,
        ['research'],
      )
      expect(grant).toEqual([])
      // and the resolved grant, fed into the predicate, hides the research row
      const viewer: AccessContext = { ...ctx(grant), userId: seed.userA1 }
      expect(await memories.getMemoryById(viewer, seed.memory.research)).toBeNull()
      expect(await memories.getMemoryById(viewer, seed.memory.untagged)).not.toBeNull()
    })
    it('sales-only member ∩ universe assistant → the member grant (sales)', async () => {
      const grant = await workspaceStore.resolveReadCompartmentsSystem(seed.salesUser, seed.workspaceA, null)
      expect(grant).toEqual(['sales'])
    })
    it('owner is unbounded on the member axis — effective grant = the assistant grant', async () => {
      // owner = universe member, so universe ∩ assistant = the assistant grant
      // (the assistant still bounds, exactly like effectiveReadClearance bounds
      // an owner by the assistant's clearance).
      expect(
        await workspaceStore.resolveReadCompartmentsSystem(seed.userA1, seed.workspaceA, ['research']),
      ).toEqual(['research'])
    })
    it('owner through a universe assistant (the primary) reads everything', async () => {
      // This is how "admin reads all" holds: universe member ∩ universe assistant = universe.
      expect(
        await workspaceStore.resolveReadCompartmentsSystem(seed.userA1, seed.workspaceA, null),
      ).toBeNull()
    })
  })

  describe('write-stamping — createMemory persists + gates the stamped compartments', () => {
    it('a memory written with compartments=[research] gates like a seeded one', async () => {
      const mem = await memories.createMemory({
        assistantId: seed.researchAssistant,
        userId: seed.userA1,
        workspaceId: seed.workspaceA,
        scope: 'workspace',
        summary: 'compcanaryword written-tagged memory',
        sensitivity: 'internal',
        compartments: ['research'],
        createdByUserId: seed.userA1,
      })
      expect(await memories.getMemoryById(ctx(['sales']), mem.id)).toBeNull()
      expect(await memories.getMemoryById(ctx(['research']), mem.id)).not.toBeNull()
      expect(await memories.getMemoryById(ctx(null), mem.id)).not.toBeNull()
    })
    it('a memory written untagged ([]) stays open to every grant', async () => {
      const mem = await memories.createMemory({
        assistantId: seed.researchAssistant,
        userId: seed.userA1,
        workspaceId: seed.workspaceA,
        scope: 'workspace',
        summary: 'compcanaryword written-untagged memory',
        sensitivity: 'internal',
        compartments: [],
        createdByUserId: seed.userA1,
      })
      expect(await memories.getMemoryById(ctx(['sales']), mem.id)).not.toBeNull()
    })
    it('a CRM deal written with compartments=[finance] gates like a seeded one', async () => {
      const deal = await crm.createDeal(seed.userA1, {
        workspaceId: seed.workspaceA,
        stage: 'lead',
        compartments: ['finance'],
      })
      expect(await crm.getDealById(ctx(['sales']), deal.id)).toBeNull()
      expect(await crm.getDealById(ctx(['finance']), deal.id)).not.toBeNull()
      expect(await crm.getDealById(ctx(null), deal.id)).not.toBeNull()
    })
  })

  describe('config layer — the registry + grant store drives enforcement', () => {
    it('an admin creates a compartment and re-grants a member; the resolver + audit reflect it', async () => {
      const store = (await import('../compartment-store.js')).createDbCompartmentStore()
      // Admin (owner) registers a new compartment.
      const entry = await store.create(seed.userA1, {
        workspaceId: seed.workspaceA,
        key: 'eng',
        label: 'Engineering',
      })
      expect(entry).not.toBeNull()
      expect((await store.registeredKeysSystem(seed.workspaceA)).has('eng')).toBe(true)

      // Re-grant the sales-only member to ['eng'] (was ['sales']).
      const ok = await store.setMemberGrant(seed.userA1, seed.workspaceA, seed.salesUser, ['eng'])
      expect(ok).toBe(true)

      // The resolver now reads the new grant straight from the column.
      expect(
        await workspaceStore.resolveReadCompartmentsSystem(seed.salesUser, seed.workspaceA, null),
      ).toEqual(['eng'])

      // Audit: one 'granted' (eng) + one 'revoked' (sales) row.
      const audit = await pool!.query<{ compartment_key: string; action: string }>(
        `SELECT compartment_key, action FROM member_compartment_grants
          WHERE workspace_id = $1 AND grantee_user_id = $2 ORDER BY compartment_key`,
        [seed.workspaceA, seed.salesUser],
      )
      const rows = audit.rows.map((r) => `${r.action}:${r.compartment_key}`).sort()
      expect(rows).toEqual(['granted:eng', 'revoked:sales'])
    })

    it('setAssistantGrant updates the assistant grant the entry points read', async () => {
      const store = (await import('../compartment-store.js')).createDbCompartmentStore()
      await store.create(seed.userA1, { workspaceId: seed.workspaceA, key: 'eng', label: 'Engineering' })
      const ok = await store.setAssistantGrant(seed.userA1, seed.researchAssistant, ['eng'], ['eng'])
      expect(ok).toBe(true)
      // owner ∩ assistant['eng'] = ['eng'] (assistant now bounds to eng).
      expect(
        await workspaceStore.resolveReadCompartmentsSystem(seed.userA1, seed.workspaceA, ['eng']),
      ).toEqual(['eng'])
    })
  })
})
