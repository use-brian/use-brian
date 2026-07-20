import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@use-brian/core'

/**
 * Integration test for WU-6.9 — the unified `getRowHistory({ primitive,
 * row_id })` surface (D.7 supersession audit + D.8 authorship).
 *
 * Requires a local `Use Brian` PostgreSQL database with mig 128
 * (universal columns) applied. Skips silently otherwise.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT valid_to, superseded_by, created_by_user_id FROM memories LIMIT 1')
      await client.query('SELECT valid_to, superseded_by FROM tasks LIMIT 1')
      await client.query('SELECT valid_to, superseded_by FROM workspace_files LIMIT 1')
      await client.query('SELECT valid_to, superseded_by FROM entities LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'rh-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerUserId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'rh-ws', 'test', $1, false)
     RETURNING id`,
    [ownerUserId],
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

async function makeAssistant(client: pg.PoolClient, ownerUserId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'rh-assistant', $1, $2)
     RETURNING id`,
    [ownerUserId, workspaceId],
  )
  return r.rows[0].id
}

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000'

describeIf('[COMP:corrections/row-history] unified getRowHistory dispatch', () => {
  let store: typeof import('../row-history-store.js')
  let memories: typeof import('../memories.js')
  let tasksDb: typeof import('../tasks.js')
  let crm: typeof import('../crm.js')
  let entities: typeof import('../entities-store.js')
  let userId: string
  let assistantId: string
  let workspaceId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../row-history-store.js')
    memories = await import('../memories.js')
    tasksDb = await import('../tasks.js')
    crm = await import('../crm.js')
    entities = await import('../entities-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
    } finally {
      client.release()
    }
    actor = { userId, workspaceId, assistantId, assistantKind: 'standard' }
  })

  it('rejects unknown primitive names', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(actor, {
        // @ts-expect-error — testing runtime validation of bad input
        primitive: 'bogus',
        row_id: UNKNOWN_UUID,
      }),
    ).rejects.toThrow(/unknown primitive/)
  })

  it('rejects non-UUID row_id', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(actor, { primitive: 'memories', row_id: 'not-a-uuid' }),
    ).rejects.toThrow(/row_id/)
  })

  it('returns null when the chain is empty (id unknown)', async () => {
    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, {
      primitive: 'memories',
      row_id: UNKNOWN_UUID,
    })
    expect(result).toBeNull()
  })

  it('memories: single-version chain + status=active + authorship surfaced', async () => {
    const m = await memories.createMemory({
      assistantId, userId,
 summary: 'Solo memory', sensitivity: 'internal',
      createdByUserId: userId, createdByAssistantId: assistantId,
    })
    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'memories', row_id: m.id })
    expect(result).not.toBeNull()
    expect(result!.api_version).toBe('v1')
    expect(result!.data.chain).toHaveLength(1)
    const v = result!.data.chain[0]
    expect(v.id).toBe(m.id)
    expect(v.primitive).toBe('memories')
    expect(v.status).toBe('active')
    expect(v.valid_to).toBeNull()
    expect(v.superseded_by).toBeNull()
    expect(v.retracted_at).toBeNull()
    expect(v.created_by_user_id).toBe(userId)
    expect(v.created_by_assistant_id).toBe(assistantId)
    expect(v.display).toMatchObject({ summary: 'Solo memory' })
    expect(result!.data.current_id).toBe(m.id)
  })

  it('memories: three-version chain in chronological order with correct statuses', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    const v3 = await memories.updateMemory(v2!.id, { summary: 'V3' })

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'memories', row_id: v2!.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.display.summary)).toEqual(['V1', 'V2', 'V3'])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('superseded')
    expect(chain[2].status).toBe('active')
    expect(chain[0].superseded_by).toBe(v2!.id)
    expect(chain[1].superseded_by).toBe(v3!.id)
    expect(chain[2].valid_to).toBeNull()
    expect(result!.data.current_id).toBe(v3!.id)
  })

  it('memories: mid-chain id returns the same chain as head id', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    const v3 = await memories.updateMemory(v2!.id, { summary: 'V3' })

    const factory = store.createDbRowHistoryStore()
    const fromMid = await factory.getRowHistory(actor, { primitive: 'memories', row_id: v2!.id })
    const fromHead = await factory.getRowHistory(actor, { primitive: 'memories', row_id: v3!.id })
    expect(fromMid!.data.chain.map((r) => r.id)).toEqual(
      fromHead!.data.chain.map((r) => r.id),
    )
    expect(fromMid!.data.current_id).toBe(v3!.id)
    expect(fromHead!.data.current_id).toBe(v3!.id)
  })

  it('memories: include_retracted=false drops retracted versions', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    // Forge a retraction on v2 directly — full retraction tool is WU-6.8 territory.
    await pool!.query(
      `UPDATE memories SET retracted_at = now(), retracted_reason = 'test', retracted_by = $2 WHERE id = $1`,
      [v2!.id, userId],
    )

    const factory = store.createDbRowHistoryStore()
    const withRetracted = await factory.getRowHistory(actor, {
      primitive: 'memories', row_id: v1.id,
    })
    expect(withRetracted!.data.chain).toHaveLength(2)
    expect(withRetracted!.data.chain[1].status).toBe('retracted')

    const withoutRetracted = await factory.getRowHistory(actor, {
      primitive: 'memories', row_id: v1.id, include_retracted: false,
    })
    expect(withoutRetracted!.data.chain).toHaveLength(1)
    expect(withoutRetracted!.data.chain[0].id).toBe(v1.id)
  })

  it('memories: as_of clamps the chain and identifies the version active at the pivot', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    await new Promise((r) => setTimeout(r, 30))
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    // Pivot between v1 creation and v2 creation — v1 should look like the head.
    const v2Row = await pool!.query<{ valid_from: Date }>(
      `SELECT valid_from FROM memories WHERE id = $1`,
      [v2!.id],
    )
    const pivot = new Date(v2Row.rows[0].valid_from.getTime() - 10).toISOString()

    const factory = store.createDbRowHistoryStore()
    const snapshot = await factory.getRowHistory(actor, {
      primitive: 'memories', row_id: v1.id, as_of: pivot,
    })
    expect(snapshot!.data.chain.map((r) => r.id)).toEqual([v1.id])
    expect(snapshot!.data.current_id).toBe(v1.id)
  })

  it('memories: invalid as_of throws a typed error', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(actor, {
        primitive: 'memories', row_id: UNKNOWN_UUID, as_of: 'not-a-date',
      }),
    ).rejects.toThrow(/as_of/)
  })

  it('tasks: superseded chain with display fields', async () => {
    const t1 = await tasksDb.createTask(userId, {
      workspaceId, title: 'T1', status: 'todo',
    })
    const t2 = await tasksDb.updateTask(userId, t1.id, { title: 'T2' })
    const t3 = await tasksDb.updateTask(userId, t2!.id, { status: 'done' })

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'tasks', row_id: t1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([t1.id, t2!.id, t3!.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[2].status).toBe('active')
    expect(chain[2].display).toMatchObject({ title: 'T2', status: 'done' })
    expect(result!.data.current_id).toBe(t3!.id)
    expect(chain.every((r) => r.created_by_user_id === userId)).toBe(true)
  })

  it('workspace_files: history with sensitivity tags carried through', async () => {
    const files = await import('../workspace-files.js')
    const f1 = await files.createWorkspaceFile(userId, {
      workspaceId,
      path: '/draft.md',
      parentPath: '/',
      name: 'draft.md',
      mime: 'text/markdown',
      sizeBytes: 10,
      storageUri: 'gs://bucket/draft.md-v1',
      title: 'Draft v1',
      tags: ['draft'],
      sensitivity: 'internal',
      // WU-4.5 authorship enforcement requires this on every insert.
      createdByUserId: userId,
    })
    // Path-stable supersession trips mig 119's UNIQUE constraint until a
    // follow-up partial-index migration lands; pass an alternate path
    // per WorkspaceFileSupersedePatch docs.
    const f2 = await files.supersedeWorkspaceFile(userId, workspaceId, f1.id, {
      editorUserId: userId,
      storageUri: 'gs://bucket/draft.md-v2',
      sizeBytes: 12,
      path: '/draft-v2.md',
      name: 'draft-v2.md',
      title: 'Draft v2',
      tags: ['draft'],
    })

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, {
      primitive: 'workspace_files', row_id: f1.id,
    })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain).toHaveLength(2)
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[1].display).toMatchObject({ title: 'Draft v2' })
    expect(result!.data.current_id).toBe(f2!.id)
  })

  it('entities: forged supersession chain walks correctly', async () => {
    // A non-CRM kind keeps this leg distinct from the CRM-primitive
    // tests above. (The old Q24 guard blocking direct CRM-kind
    // createEntity went with mig 296.) The row-history walker is
    // kind-agnostic, so 'project' exercises the supersession chain
    // identically.
    const e1 = await entities.createEntity({
      kind: 'project',
      displayName: 'Acme v1',
      workspaceId,
      userId,
      createdByUserId: userId,
      source: 'user',
    })
    const e2 = await entities.createEntity({
      kind: 'project',
      displayName: 'Acme v2',
      workspaceId,
      userId,
      createdByUserId: userId,
      source: 'user',
    })
    // Forge a supersession edge — entity merge is WU-6.7's tool; this
    // test only exercises the walker.
    await pool!.query(
      `UPDATE entities SET valid_to = now(), superseded_by = $2 WHERE id = $1`,
      [e1.id, e2.id],
    )

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'entities', row_id: e1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([e1.id, e2.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[0].superseded_by).toBe(e2.id)
    expect(chain[0].display).toMatchObject({ kind: 'project', displayName: 'Acme v1' })
    expect(result!.data.current_id).toBe(e2.id)
  })

  // Post CRM→entity unification (mig 296) a company / contact / deal IS an
  // `entities` row; the `companies` / `contacts` / `deals` primitives dispatch
  // to the same entity history walker (fetchEntityVersions), so their chain +
  // display are entity-shaped ({ kind, displayName, canonicalId }) — there is
  // no `name` / `stage` display leg any more. CRM writes update IN PLACE
  // (updateEntity, no supersession — crm-entity-unification.md D5), so a
  // multi-version chain exists only when the underlying entity is superseded;
  // these forge that edge to exercise the walker through the CRM primitive,
  // exactly like the `entities` test above.

  it('companies: the companies primitive walks the entity supersession chain', async () => {
    const c1 = await crm.createCompany(userId, { workspaceId, name: 'CoA' })
    const c2 = await crm.createCompany(userId, { workspaceId, name: 'CoB' })
    await pool!.query(
      `UPDATE entities SET valid_to = now(), superseded_by = $2 WHERE id = $1`,
      [c1.id, c2.id],
    )

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'companies', row_id: c1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([c1.id, c2.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[0].display).toMatchObject({ kind: 'company', displayName: 'CoA' })
    expect(chain[1].display).toMatchObject({ kind: 'company', displayName: 'CoB' })
    expect(result!.data.current_id).toBe(c2.id)
  })

  it('contacts: the contacts primitive walks the entity chain (kind=person)', async () => {
    const c1 = await crm.createContact(userId, { workspaceId, name: 'PersonA' })
    const c2 = await crm.createContact(userId, { workspaceId, name: 'PersonB' })
    await pool!.query(
      `UPDATE entities SET valid_to = now(), superseded_by = $2 WHERE id = $1`,
      [c1.id, c2.id],
    )

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'contacts', row_id: c1.id })
    expect(result!.data.chain).toHaveLength(2)
    expect(result!.data.chain[0].display).toMatchObject({ kind: 'person', displayName: 'PersonA' })
    expect(result!.data.chain[1].display).toMatchObject({ kind: 'person', displayName: 'PersonB' })
    expect(result!.data.current_id).toBe(c2.id)
  })

  it('deals: the deals primitive walks the entity chain (kind=deal)', async () => {
    const d1 = await crm.createDeal(userId, { workspaceId, stage: 'qualified' })
    const d2 = await crm.createDeal(userId, { workspaceId, stage: 'proposal' })
    await pool!.query(
      `UPDATE entities SET valid_to = now(), superseded_by = $2 WHERE id = $1`,
      [d1.id, d2.id],
    )

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(actor, { primitive: 'deals', row_id: d1.id })
    expect(result!.data.chain.map((r) => r.id)).toEqual([d1.id, d2.id])
    expect(result!.data.chain[0].status).toBe('superseded')
    expect(result!.data.chain[1].status).toBe('active')
    expect(result!.data.chain.every((r) => r.display.kind === 'deal')).toBe(true)
    expect(result!.data.current_id).toBe(d2.id)
  })
})
