import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, applyRLSGucs, rollbackAndRelease } from '../client.js'
import { createEntity, getOrCreateSelfEntity, getOrCreateClientContactEntity, getOrCreateClientContactAndLeadEntities, supersedeEntity } from '../entities-store.js'
import { createEntityLink, createDbEntityLinksStore } from '../entity-links-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { admitEntityCreate } from '../../workspace-access/entity-create-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture(mode = 'simple', ready = true) {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Entity admission',$2)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Entity','standard')", [assistantId,workspaceId,userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId,workspaceId,{ name:'Default',key:'default' })
  const other = await groups.createTeam(userId,workspaceId,{ name:'Other',key:'other' })
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1', [workspaceId,mode,ready?'ready':'legacy',team.id])
  const entity = (patch: Record<string,unknown> = {}) => createEntity({workspaceId,createdByUserId:userId,kind:'person',displayName:'Admission',source:'user',...patch})

  const link = (a: string,b: string, patch: Record<string,unknown> = {}) => createEntityLink(userId,{workspaceId,sourceKind:'entity',sourceId:a,targetKind:'entity',targetId:b,edgeType:'works_at',source:'user',...patch})
  return {userId,workspaceId,assistantId,team,other,entity,link}
}
describe('canonical entity and link mode admission', () => {
  it.each([false, true])('rejects malformed direct app-role derived envelopes without outputs (ready=%s)', async ready => {
    const f = await fixture('departments', ready), projectId = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Derived project','derived project',$3)", [projectId, f.workspaceId, f.userId])
    const source = await f.entity({ userId: f.userId, assistantId: f.assistantId, sensitivity: 'confidential', compartments: [f.other.compartmentKey], projectIds: [projectId] })
    const snapshot = (await pool.query("SELECT read_scope_source($1,'entity',$2) AS source", [f.workspaceId, source.id])).rows[0].source
    const derivation = { producer: 'direct-sql-regression', sources: [snapshot] }
    const input = { workspaceId: f.workspaceId, createdByUserId: f.userId, kind: 'person' as const, displayName: 'Malformed output', source: 'extracted' as const,
      userId: f.userId, assistantId: f.assistantId, sensitivity: 'confidential' as const, compartments: [f.other.compartmentKey!], projectIds: [projectId], derivation }
    const malformed: Array<Record<string, unknown>> = []
    for (const field of ['workspaceId', 'userId', 'assistantId', 'sensitivity', 'compartments', 'projectIds']) {
      const missing: Record<string, unknown> = { ...input }; delete missing[field]; malformed.push(missing)
    }
    for (const field of ['compartments', 'projectIds']) {
      for (const value of [null, 'not-array', {}, [null], [123], [{}]]) malformed.push({ ...input, [field]: value })
    }
    for (const patch of [{ sensitivity: null }, { sensitivity: 1 }, { sensitivity: 'unknown' }, { userId: false }, { assistantId: {} }, { projectIds: ['not-uuid'] }, { compartments: [''] }]) malformed.push({ ...input, ...patch })
    const client = await getAppPool().connect()
    try {
      for (const body of malformed) {
        await client.query('BEGIN'); await applyRLSGucs(client, f.userId)
        // Supply a genuine ready-mode receipt first: rejection must be envelope
        // validation, not an unrelated missing-receipt failure.
        await admitEntityCreate(client, input)
        await expect(client.query('SELECT * FROM create_source_derived_entity($1::jsonb,$2::jsonb)', [JSON.stringify(body), JSON.stringify(derivation)])).rejects.toThrow('scope_evidence_missing')
        await client.query('ROLLBACK')
      }
      for (const patch of [{ compartments: [] }, { projectIds: [] }]) {
        await client.query('BEGIN'); await applyRLSGucs(client, f.userId)
        await admitEntityCreate(client, input)
        await expect(client.query('SELECT * FROM create_source_derived_entity($1::jsonb,$2::jsonb)', [JSON.stringify({ ...input, ...patch }), JSON.stringify(derivation)])).rejects.toThrow('scope_visibility_incompatible')
        await client.query('ROLLBACK')
      }
    } finally { await rollbackAndRelease(client) }
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: source.id }])
    expect((await pool.query('SELECT id FROM scope_derivations WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    expect((await pool.query('SELECT derivation_id FROM scope_derivation_sources WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
  })
  it('ignores embedding maintenance for versions and descendant holds but invalidates semantic edits', async () => {
    const f = await fixture('departments'), source = await f.entity({ compartments: [f.other.compartmentKey] })
    const snapshot = (await pool.query("SELECT read_scope_source($1,'entity',$2) AS source", [f.workspaceId, source.id])).rows[0].source
    const child = await f.entity({ source: 'extracted', derivation: { producer: 'maintenance-regression', sources: [snapshot] } })
    const version = async () => (await pool.query('SELECT scope_version::text AS version FROM entities WHERE id=$1', [source.id])).rows[0].version
    const held = async () => (await pool.query('SELECT scope_held FROM entities WHERE id=$1', [child.id])).rows[0].scope_held
    const revision = (await pool.query('SELECT revision::text AS revision FROM workspace_access_policies WHERE workspace_id=$1', [f.workspaceId])).rows[0].revision
    await pool.query("UPDATE entities SET embedding_failed_at=now(),embedding_failure_reason='retryable' WHERE id=$1", [source.id])
    expect(await version()).toBe(snapshot.version); expect(await held()).toBe(false)
    await pool.query(`UPDATE entities SET embedding=$2::vector,embedding_model_id='regression-model',content_hash='completed-hash',
      embedding_updated_at=now(),embedding_failed_at=NULL,embedding_failure_reason=NULL,updated_at=now(),centrality=0.5,centrality_computed_at=now() WHERE id=$1`,
    [source.id, JSON.stringify(Array.from({ length: 768 }, () => 0.01))])
    expect(await version()).toBe(snapshot.version); expect(await held()).toBe(false)
    expect((await pool.query('SELECT revision::text AS revision FROM workspace_access_policies WHERE workspace_id=$1', [f.workspaceId])).rows[0].revision).toBe(revision)
    await pool.query("UPDATE entities SET display_name='Semantic edit' WHERE id=$1", [source.id])
    expect(BigInt(await version())).toBe(BigInt(snapshot.version) + 1n)
    expect(await held()).toBe(true)
  })
  it('creates app-role derived entities with exact evidence and invalidates descendants', async () => {
    const f = await fixture('departments')
    const source = await f.entity({ userId: f.userId, assistantId: f.assistantId, compartments: [f.other.compartmentKey], sensitivity: 'confidential' })
    const snapshot = (await pool.query("SELECT read_scope_source($1,'entity',$2) AS source", [f.workspaceId, source.id])).rows[0].source
    const derivation = { producer: 'test-canonical-entity', sources: [snapshot] }
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.workspaceId])
    const child = await f.entity({ source: 'extracted', derivation })
    expect(child).toMatchObject({ userId: f.userId, assistantId: f.assistantId, compartments: [f.other.compartmentKey], sensitivity: 'confidential' })
    expect((await pool.query("SELECT 1 FROM scope_derivations WHERE resource_kind='entity' AND resource_id=$1", [child.id])).rowCount).toBe(1)
    await pool.query("UPDATE entities SET display_name='Changed' WHERE id=$1", [source.id])
    expect((await pool.query('SELECT scope_held FROM entities WHERE id=$1', [child.id])).rows[0].scope_held).toBe(true)
    await expect(f.entity({ source: 'extracted', derivation })).rejects.toThrow('scope_source_changed')
  })
  it('allows only inherited read-grant floors and rejects added requirements, held and foreign evidence', async () => {
    const f = await fixture('departments')
    const source = await f.entity({ compartments: [f.other.compartmentKey] })
    const snapshot = (await pool.query("SELECT read_scope_source($1,'entity',$2) AS source", [f.workspaceId, source.id])).rows[0].source
    const derivation = { producer: 'test-read-grant', sources: [snapshot] }
    const access = { workspaceId: f.workspaceId, userId: f.userId, clearance: 'confidential' as const, compartments: null, mutationCompartments: [], projectIds: null }
    expect(await runWithAgentAccess(access, () => f.entity({ source: 'extracted', derivation }))).toMatchObject({ compartments: [f.other.compartmentKey] })
    await expect(runWithAgentAccess(access, () => f.entity({ source: 'extracted', derivation, compartments: [f.team.compartmentKey] }))).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.entity({ source: 'extracted', derivation: { ...derivation, sources: [{ ...snapshot, version: '0' }] } })).rejects.toThrow('scope_source_changed')
    const foreign = await fixture('departments')
    await expect(foreign.entity({ source: 'extracted', derivation })).rejects.toBeDefined()
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1', [source.id])
    await expect(f.entity({ source: 'extracted', derivation })).rejects.toThrow('scope_source_changed')
  })
  it('defaults only omitted shared roots, including assistant-only rows; keeps personal roots private', async () => {
    const f=await fixture()
    expect(await f.entity()).toMatchObject({compartments:[f.team.compartmentKey],userId:null})
    expect(await f.entity({assistantId:f.assistantId})).toMatchObject({compartments:[f.team.compartmentKey],assistantId:f.assistantId,userId:null})
    expect(await f.entity({userId:f.userId})).toMatchObject({compartments:[],userId:f.userId})
    for (const compartments of [[],null,[f.other.compartmentKey]]) await expect(f.entity({compartments})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(f.entity({projectIds:null})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(f.entity({userId:randomUUID()})).rejects.toMatchObject({code:'context_not_available'})
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:[],projectIds:null},()=>f.entity())).rejects.toMatchObject({code:'context_not_available'})
  })
  it('requires Departments selection, allows explicit General, and keeps legacy unchanged',async()=>{
    const f=await fixture('departments')
    await expect(f.entity()).rejects.toMatchObject({code:'context_selection_required'})
    expect((await f.entity({compartments:[]})).compartments).toEqual([])
    expect((await f.entity({compartments:[f.other.compartmentKey]})).compartments).toEqual([f.other.compartmentKey])
    await expect(f.entity({compartments:['unknown']})).rejects.toMatchObject({code:'context_not_available'})
    await expect(f.entity({compartments:[],projectIds:[randomUUID()]})).rejects.toMatchObject({code:'context_not_available'})
    const legacy=await fixture('simple',false)
    expect((await legacy.entity()).compartments).toEqual([])
  })
  it('routes self creation through admission and fails closed for unbound external client helpers and provenance',async()=>{
    const f=await fixture()
    expect(await getOrCreateSelfEntity({...f,displayName:'Self'})).toMatchObject({userId:f.userId,compartments:[]})
    const external={...f,userId:randomUUID(),displayName:'Client',externalUserId:'client'}
    await expect(getOrCreateClientContactEntity(external)).rejects.toThrow('scope_evidence_missing')
    await expect(getOrCreateClientContactAndLeadEntities({...external,identityNamespace:'test',lead:{key:'lead'}})).rejects.toThrow('scope_evidence_missing')
    for (const patch of [{source:'extracted'},{sourceEpisodeId:randomUUID()},{sourceSessionId:randomUUID()}]) await expect(f.entity(patch)).rejects.toThrow('scope_evidence_missing')
  })
  it('does not treat body labels as source-derived provenance',async()=>{
    const f=await fixture('departments')
    for (const source of ['model','extracted','kb_sync','rem_connection','auto-generated','community']) {
      await expect(f.entity({source,compartments:[f.other.compartmentKey],userId:f.userId})).rejects.toThrow('scope_evidence_missing')
    }
    expect((await pool.query('SELECT 1 FROM entities WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('preserves predecessor floors on supersession without applying a new default',async()=>{
    const f=await fixture('departments'),root=await f.entity({userId:f.userId,compartments:[f.other.compartmentKey],sensitivity:'confidential'})
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[f.workspaceId])
    expect(await supersedeEntity(f.userId,root.id,{attributes:{next:true}})).toMatchObject({userId:f.userId,compartments:[f.other.compartmentKey],sensitivity:'confidential'})
  })
  it('inherits canonical link endpoints, keeps idempotency, and denies held/foreign/unsupported endpoints',async()=>{
    const f=await fixture('departments'),a=await f.entity({userId:f.userId,compartments:[f.other.compartmentKey],sensitivity:'confidential'}),b=await f.entity({compartments:[]})
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[f.workspaceId])
    const link=await f.link(a.id,b.id)
    expect(link).toMatchObject({userId:f.userId,sensitivity:'confidential',compartments:[f.other.compartmentKey]})
    expect((await f.link(a.id,b.id)).id).toBe(link.id)
    const foreign=await fixture(),c=await foreign.entity()
    await expect(f.link(a.id,c.id)).rejects.toMatchObject({code:'context_not_available'})
    await expect(f.link(a.id,b.id,{targetKind:'assistant',targetId:f.assistantId})).rejects.toThrow('scope_evidence_missing')
    await pool.query('UPDATE entity_links SET scope_held=true WHERE id=$1',[link.id])
    await expect(f.link(a.id,b.id)).rejects.toMatchObject({code:'context_not_available'})
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[a.id])
    await expect(f.link(a.id,b.id,{edgeType:'mentioned'})).rejects.toMatchObject({code:'context_not_available'})
  })
  it('does not treat assistant-only links as personal or invent an assistant owner actor',async()=>{
    const f=await fixture(),a=await f.entity({assistantId:f.assistantId}),b=await f.entity({assistantId:f.assistantId})
    expect(await f.link(a.id,b.id,{assistantId:f.assistantId})).toMatchObject({userId:null,assistantId:f.assistantId,compartments:[f.team.compartmentKey]})
    await expect(f.link(a.id,b.id,{compartments:[]})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(createDbEntityLinksStore().create({workspaceId:f.workspaceId,assistantId:f.assistantId,sourceKind:'entity',sourceId:a.id,targetKind:'entity',targetId:b.id,edgeType:'mentioned',source:'user'})).rejects.toBeDefined()
  })
  it('keeps private and Project endpoint floors despite explicit null visibility and empty body labels',async()=>{
    const f=await fixture('departments'),projectId=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Link project','link project',$3)",[projectId,f.workspaceId,f.userId])
    const a=await f.entity({userId:f.userId,assistantId:f.assistantId,compartments:[f.other.compartmentKey],projectIds:[projectId],sensitivity:'confidential'})
    const b=await f.entity({compartments:[]})
    expect(await f.link(a.id,b.id,{userId:null,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]})).toMatchObject({
      userId:f.userId,assistantId:f.assistantId,sensitivity:'confidential',compartments:[f.other.compartmentKey],projectIds:[projectId],
    })
    await expect(f.link(a.id,b.id,{userId:randomUUID()})).rejects.toBeDefined()
    await expect(f.link(a.id,b.id,{compartments:['unknown']})).rejects.toMatchObject({code:'context_not_available'})
    await expect(f.link(a.id,b.id,{projectIds:[randomUUID()]})).rejects.toMatchObject({code:'context_not_available'})
    await expect(f.link(a.id,b.id,{compartments:null})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:[],projectIds:null},()=>f.link(a.id,b.id))).rejects.toMatchObject({code:'context_not_available'})
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,projectIds:[]},()=>f.link(a.id,b.id))).rejects.toBeDefined()
  })
  it('narrows an existing link when current endpoint privacy and sensitivity become stricter',async()=>{
    const f=await fixture(),a=await f.entity({assistantId:f.assistantId}),b=await f.entity({assistantId:f.assistantId})
    const first=await f.link(a.id,b.id)
    await pool.query("UPDATE entities SET user_id=$2,sensitivity='confidential' WHERE id=$1",[a.id,f.userId])
    const narrowed=await f.link(a.id,b.id)
    expect(narrowed).toMatchObject({id:first.id,userId:f.userId,assistantId:f.assistantId,sensitivity:'confidential'})
  })
  it('rejects foreign private endpoints even in an owner-pool composed transaction',async()=>{
    const f=await fixture('departments'),otherId=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[otherId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,otherId])
    const a=await f.entity({userId:f.userId}),b=await f.entity({userId:f.userId}),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(createEntityLink(otherId,{workspaceId:f.workspaceId,userId:otherId,sourceKind:'entity',sourceId:a.id,targetKind:'entity',targetId:b.id,edgeType:'works_at',source:'user'},client)).rejects.toMatchObject({code:'context_not_available'})
    } finally { await rollbackAndRelease(client) }
    expect((await pool.query('SELECT id FROM entity_links WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('rejects supersession declassification and newly attached unvalidated provenance',async()=>{
    const f=await fixture(),root=await f.entity({userId:f.userId,sensitivity:'confidential'})
    await expect(supersedeEntity(f.userId,root.id,{attributes:{},sensitivity:'public'})).rejects.toMatchObject({code:'scope_declassification_required'})
    await expect(supersedeEntity(f.userId,root.id,{attributes:{},sourceEpisodeId:randomUUID()})).rejects.toThrow('scope_evidence_missing')
    await expect(supersedeEntity(f.userId,root.id,{attributes:{},source:'model'})).rejects.toThrow('scope_evidence_missing')
  })
  it('rejects a foreign assistant partition instead of treating it as a destination workspace',async()=>{
    const f=await fixture(),other=await fixture(),a=await f.entity({userId:f.userId})
    await expect(f.entity({assistantId:other.assistantId})).rejects.toMatchObject({code:'context_not_available'})
    await expect(f.link(a.id,a.id,{assistantId:other.assistantId})).rejects.toMatchObject({code:'context_not_available'})
  })
  it('uses caller transactions, restores policy bypass, and rolls back admitted entities and links',async()=>{
    const f=await fixture(),client=await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,f.userId)
      const a=await createEntity({workspaceId:f.workspaceId,createdByUserId:f.userId,kind:'person',displayName:'Rollback',source:'user',assistantId:f.assistantId},client)
      await createEntityLink(f.userId,{workspaceId:f.workspaceId,sourceKind:'entity',sourceId:a.id,targetKind:'entity',targetId:a.id,edgeType:'mentioned',source:'user'},client)
      expect((await client.query("SELECT current_setting('app.system_bypass',true) AS bypass")).rows[0].bypass).not.toBe('true')
    } finally { await rollbackAndRelease(client) }
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM entity_links WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
})
