import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator, type AccessContext, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createEntity } from '../entities-store.js'
import { createMemory, getIdentityMemories, getMemoryByIdSystem, getSelfEntityId } from '../memories.js'
import { createDbMemoryStore } from '../memory-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { noteAutomaticScopeEvidence } from '../../context-scope/resolve-turn-scope.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Identity fixture',$2,false)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)", [projectId, workspaceId, userId])
  const entity = await createEntity({ kind: 'person', displayName: 'Fictional member',
    workspaceId, userId, assistantId: null, createdByUserId: userId, source: 'user',
    attributes: { self: true, name: 'Fictional member', role: 'Planning lead' },
    sensitivity: 'confidential', compartments: ['finance'], projectIds: [projectId] })
  await pool.query('UPDATE users SET entity_id=$1 WHERE id=$2', [entity.id, userId])
  const ctx: AccessContext = { workspaceId, userId, assistantId, assistantKind: 'primary',
    clearance: 'confidential', compartments: ['finance'], projectIds: [projectId] }
  const canonical = async () => (await pool.query('SELECT read_scope_source($1,$2,$3) AS source',
    [workspaceId, 'entity', entity.id])).rows[0].source as ScopeSource
  return { ctx, entity, canonical }
}

describe('[COMP:api/identity-context] canonical identity prompt scope', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('retains the actual entity envelope and records full entity evidence through the memory adapter', async () => {
    const f = await fixture()
    const rows = await createDbMemoryStore().getIdentity(f.ctx)
    expect(rows).toHaveLength(2)
    const source = await f.canonical()
    for (const row of rows) {
      expect(row).toMatchObject({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
        assistantId: null, sensitivity: 'confidential', compartments: ['finance'],
        projectIds: f.ctx.projectIds, scopeVersion: source.version,
        scopeSource: { resourceKind: 'entity', resourceId: f.entity.id, version: source.version } })
      expect(row.scopeSource?.resourceId).not.toBe(row.id)
    }
    expect(await getSelfEntityId(f.ctx)).toBe(f.entity.id)
    const accumulator = new ContextScopeAccumulator()
    noteAutomaticScopeEvidence(accumulator, rows)
    expect(accumulator.evidence).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds })
    // Both identity rows come from the one entity; the accumulator keeps one
    // source per resource (the latest read supersedes), so one lineage entry.
    expect(accumulator.evidence.sources).toEqual([expect.objectContaining({ resourceKind: 'entity', resourceId: f.entity.id })])
    const derived = await createMemory({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
      assistantId: f.ctx.assistantId, createdByUserId: f.ctx.userId, summary: 'Protected identity note',
      sensitivity: 'public', derivation: { producer: 'identity-context-test', sources: accumulator.evidence.sources! } })
    expect(derived).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds })
    const edges = await pool.query('SELECT s.source_kind,s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1', [derived.id])
    expect(edges.rows).toEqual([{ source_kind: 'entity', source_id: f.entity.id }])
    await pool.query("UPDATE entities SET attributes=attributes || '{\"role\":\"Revised role\"}'::jsonb WHERE id=$1", [f.entity.id])
    expect(await getMemoryByIdSystem(derived.id)).toBeNull()
    await expect(createMemory({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
      assistantId: f.ctx.assistantId, createdByUserId: f.ctx.userId, summary: 'Stale identity note',
      sensitivity: 'public',
      derivation: { producer: 'identity-context-test', sources: accumulator.evidence.sources! } })).rejects.toMatchObject({ code: 'scope_source_changed' })
  })

  it.each(['clearance', 'team', 'project', 'workspace', 'user', 'assistant'] as const)(
    'withholds identity text and ID outside the %s axis', async axis => {
      const f = await fixture()
      let ctx = { ...f.ctx }
      if (axis === 'clearance') ctx.clearance = 'internal'
      if (axis === 'team') ctx.compartments = ['product']
      if (axis === 'project') ctx.projectIds = []
      if (axis === 'workspace') ctx.workspaceId = randomUUID()
      if (axis === 'user') ctx.userId = randomUUID()
      if (axis === 'assistant') {
        await pool.query('UPDATE entities SET assistant_id=$1 WHERE id=$2', [f.ctx.assistantId, f.entity.id])
        ctx = { ...ctx, assistantKind: 'standard', assistantId: randomUUID() }
      }
      expect(await getIdentityMemories(ctx)).toEqual([])
      expect(await getSelfEntityId(ctx)).toBeNull()
    })

  it.each(['held', 'retracted', 'superseded'] as const)('withholds %s identity even from an ordinary broad owner context', async state => {
    const f = await fixture()
    const statement = state === 'held' ? 'scope_held=true' : state === 'retracted' ? 'retracted_at=now()' : 'valid_to=now()'
    await pool.query(`UPDATE entities SET ${statement} WHERE id=$1`, [f.entity.id])
    const ctx = { ...f.ctx, compartments: null, projectIds: null }
    expect(await getIdentityMemories(ctx)).toEqual([])
    expect(await getSelfEntityId(ctx)).toBeNull()
  })

  it('intersects reconstructed owner context with the executing caller before fetching text or IDs', async () => {
    const f = await fixture()
    await runWithAgentAccess({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
      clearance: 'confidential', compartments: [], projectIds: null }, async () => {
      const owner = { ...f.ctx, compartments: null, projectIds: null }
      expect(await getIdentityMemories(owner)).toEqual([])
      expect(await getSelfEntityId(owner)).toBeNull()
    })
  })

  it('preserves explicit General identity and does not mint canonical evidence from nested content', async () => {
    const f = await fixture()
    await pool.query("UPDATE entities SET compartments='{}',project_ids='{}',sensitivity='internal' WHERE id=$1", [f.entity.id])
    expect(await getIdentityMemories({ ...f.ctx, compartments: [], projectIds: [], clearance: 'internal' })).toHaveLength(2)
    const accumulator = new ContextScopeAccumulator()
    noteAutomaticScopeEvidence(accumulator, [{ detail: { scopeSource: await f.canonical() } }])
    expect(accumulator.evidence.sources).toBeUndefined()
  })
})
