import {authSessionStore} from '../auth-session-store.js'
import {createPersonalWebSession} from '../sessions.js'
import {findAssistantById} from '../users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import type {PoolClient} from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator,boundScopeSources,deriveResourceScope,createSelfProfileTool,type AccessContext,type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createEntity,updateSelfEntityAttributes,createDbEntitiesStore } from '../entities-store.js'
import {createDbEntityLinksStore} from '../entity-links-store.js'
import { createMemory, getIdentityMemories, getMemoryByIdSystem, getSelfEntityId } from '../memories.js'
import { createDbMemoryStore } from '../memory-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { noteAutomaticScopeEvidence } from '../../context-scope/resolve-turn-scope.js'
import {sourceModeFixture} from '../../application-platform/__tests__/fixtures/source-modes.js'
import {originalMemoryAuthority} from '../../application-platform/__tests__/fixtures/retained-memory.js'
import {readRetainedContextFrame,writeRetainedContextFrame} from '../session-context-revisions.js'
import {configureConnectorSourceRuntimeFactory} from '../../application-platform/source-runtime.js'
import {assertSourceModelInputAuthority} from '../../application-platform/model-source-authority.js'
import {canonicalNativeResourceDefinitions} from '../../application-platform/native-resources.js'
import {readCanonicalNativeRecord} from '../../application-platform/field-evidence.js'
import {queryCanonicalNativeRecords} from '../../application-platform/native-reader.js'
import {applicationQuerySchema} from '@use-brian/shared'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Identity fixture',$2,false)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'primary')", [assistantId, workspaceId, userId])
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

async function identityPublicationAuthority(ctx:AccessContext,accumulator:ContextScopeAccumulator){
  const auth=await authSessionStore.create(ctx.userId,{deviceLabel:'Fictional identity device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual identity auth session')
  const session=await createPersonalWebSession({assistantId:ctx.assistantId,userId:ctx.userId,workspaceId:ctx.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
    {actorUserId:ctx.userId,authSessionId:auth.id,authVersion:auth.authVersion})
  const assistant=await findAssistantById(ctx.assistantId)
  if(!assistant||assistant.kind!=='primary')throw new Error('Missing actual primary identity assistant')
  const claims=Object.freeze({userId:ctx.userId,sessionId:auth.id,authVersion:auth.authVersion})
  const resolved=await resolveExecutionContextSystem({userId:ctx.userId,workspaceId:ctx.workspaceId,assistant,memberMode:'member',sharedAudience:false,session,sessionAuthority:session,
    identity:{kind:'attended',principal:{kind:'workspace_member',userId:ctx.userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:ctx.workspaceId},
    lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
    credentialCurrent:async()=>!!await authSessionStore.validateAccess(claims)})
  expect(resolved.executionContext.security.access.clearance).toBe('confidential')
  return {execution:resolved.executionContext,accumulator}
}

describe('[COMP:api/identity-context] canonical identity prompt scope', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('keeps known onboarding profile writes and selected identity codecs on distinct canonical fields',async()=>{
    const x=await sourceModeFixture('internal')
    try{
      const self=await updateSelfEntityAttributes({userId:x.f.ownerId,workspaceId:x.f.workspaceId,displayName:'Fictional identity',
        attributes:{name:'Fictional stored name',role:'Planning lead',company:'Fictional company',location:'Fictional city',birthday:'2000-01-02',pronouns:'they/them',role_or_company:'Fictional legacy title',sources:['https://profile.example/source']}})
      const legacy=await createDbMemoryStore().getIdentity({...x.f.envelope,userId:x.f.ownerId,assistantId:x.f.assistantId,assistantKind:'primary',clearance:'internal'})
      expect(legacy.map(row=>row.summary)).toContain("User's role: Planning lead")
      const current=await originalMemoryAuthority(x),rows=await createDbMemoryStore().getIdentity(current.execution.security.access,current)
      expect(rows.map(row=>row.summary)).toEqual(expect.arrayContaining(["User's name is Fictional stored name","User's role: Planning lead",'Sources: ["https://profile.example/source"]']))
      noteAutomaticScopeEvidence(current.accumulator,rows)
      expect(current.accumulator.evidence.sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'entity',resourceId:self.id}),expect.objectContaining({resourceKind:'application_field'})]))
      expect(boundScopeSources(rows).some(root=>root.resourceKind==='application_field')).toBe(true)
      expect((await x.f.pool.query(`SELECT application_native_entity_values('person',$1::jsonb,ARRAY['profile.name']) AS selected,
        application_native_entity_attribute_values('{"name":"Fictional stored name"}') AS aliases`,[{display_name:'Fictional display',attributes:{self:true,name:'Fictional stored name',role:'Hidden selected control'}}])).rows[0]).toEqual({selected:{'profile.name':{value:'Fictional stored name'}},aliases:{'profile.name':'Fictional stored name'}})
      const defaults=(await x.f.pool.query(`SELECT application_native_entity_values('person','{"attributes":{}}',ARRAY['tags','externalRef']) AS absent,
        application_native_entity_values('person','{"attributes":{"tags":[],"external_ref":{}}}',ARRAY['tags','externalRef']) AS explicit,
        application_native_entity_values('company','{"attributes":{}}',ARRAY['tags','externalRef']) AS company`)).rows[0]
      expect(defaults).toEqual({absent:{tags:null,externalRef:null},explicit:{tags:[],externalRef:{}},company:{tags:[],externalRef:{}}})
      const root=(await x.f.pool.query("SELECT read_scope_source($1,'entity',$2) AS source",[x.f.workspaceId,self.id])).rows[0].source
      await expect(readRetainedContextFrame(current,[root],client=>client.query("SELECT application_create_canonical_crm_ref('person',$1::jsonb,$2::jsonb)",[{name:'Fictional prohibited create','profile.role':'Unrequested writer'},{workspaceId:x.f.workspaceId,sensitivity:'internal',compartments:[],projectIds:[]}]))).rejects.toMatchObject({code:'22023',message:'invalid_value'})
      await expect(createDbMemoryStore().getIdentity({...current.execution.security.access,userId:x.f.secondId},current)).rejects.toMatchObject({code:'scope_evidence_missing'})
      const signature='public.application_native_builtin_field_revision(text,text)',definition=(await x.f.pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition as string
      const revised="WHEN p_type='person' AND p_field='self' THEN 2",legacyRevision=definition.replace(revised,revised.replace('THEN 2','THEN 1')).replace("(starts_with(p_field,'profile.') OR p_field IN('tags','externalRef')) THEN 2","(starts_with(p_field,'profile.') OR p_field IN('tags','externalRef')) THEN 1")
      expect(legacyRevision).not.toBe(definition)
      const person=canonicalNativeResourceDefinitions().find(value=>value.typeKey==='person')!,input=applicationQuerySchema.parse({fields:['self','profile.role','tags','externalRef'],filters:[{field:'self',op:'eq',value:true}]})
      const capture=async()=>{const authority=await originalMemoryAuthority(x);return readRetainedContextFrame(authority,[],async client=>{
        const context={transaction:client,workspaceId:x.f.workspaceId}
        return {point:await readCanonicalNativeRecord(context,person,self.id,['self','profile.role','tags','externalRef']),query:await queryCanonicalNativeRecords(context,person,input)}
      })}
      let old:Awaited<ReturnType<typeof capture>>
      try{await x.f.pool.query(legacyRevision);old=await capture();expect(old.point.values).toEqual({self:true,'profile.role':{value:'Planning lead'},tags:null,externalRef:null});expect(old.query.records.map(value=>value.ref.id)).toContain(self.id)}
      finally{await x.f.pool.query(definition)}
      const roots=[...boundScopeSources(old!.point),...boundScopeSources(old!.query)];expect(roots.length).toBeGreaterThan(1)
      const original=(await x.f.pool.query('SELECT resource_id,version,record_version,policy_version,source_scope FROM application_field_observations WHERE workspace_id=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,version',[x.f.workspaceId,roots.map(root=>root.resourceId)])).rows
      const reader=await originalMemoryAuthority(x)
      await readRetainedContextFrame(reader,[],async client=>{for(const root of roots)expect((await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[x.f.workspaceId,root.resourceId,root.version])).rows[0].value).toMatchObject({held:true})})
      const fresh=await capture();expect(fresh.point.values).toEqual({self:true,'profile.role':{value:'Planning lead'},tags:null,externalRef:null});expect(fresh.query.records.map(value=>value.ref.id)).toContain(self.id)
      expect((await x.f.pool.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[self.id])).rows[0].version).toBe(root.version)
      expect((await x.f.pool.query('SELECT resource_id,version,record_version,policy_version,source_scope FROM application_field_observations WHERE workspace_id=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,version',[x.f.workspaceId,roots.map(root=>root.resourceId)])).rows).toEqual(original)
      expect(await createDbMemoryStore().getIdentity({...current.execution.security.access,sharedAudience:true},current)).toEqual([])
      expect(await createDbMemoryStore().getIdentity({...current.execution.security.access,clearance:'public'},current)).toEqual([])
      await updateSelfEntityAttributes({userId:x.f.ownerId,workspaceId:x.f.workspaceId,displayName:'Fictional identity',attributes:{self:false}})
      const empty=await originalMemoryAuthority(x),emptyRows=await createDbMemoryStore().getIdentity(empty.execution.security.access,empty)
      expect(emptyRows).toEqual([]);expect(boundScopeSources(emptyRows).some(root=>root.resourceKind==='application_field')).toBe(true)
      noteAutomaticScopeEvidence(empty.accumulator,[emptyRows,...emptyRows])
      expect(empty.accumulator.evidence.sources?.some(root=>root.resourceKind==='application_field')).toBe(true)
      await expect(assertSourceModelInputAuthority(empty.context)).resolves.toBeUndefined()
    }finally{await x.cleanup()}
  })

  it('preserves arbitrary self-profile tool values through selection-scoped canonical envelopes',async()=>{
    const x=await sourceModeFixture('internal')
    try{
      const current=await originalMemoryAuthority(x),store=createDbEntitiesStore({entityLinks:createDbEntityLinksStore()}),tool=createSelfProfileTool(store)
      const extra=JSON.parse('{"name":42,"role":{"title":"Fictional planning lead"},"sources":{"legacy":true},"licenses":["fictional",7],"title":"Fictional pilot","domain":"fictional.example","stage":false,"empty":null}')
      const result=await tool.execute({name:'Fictional typed name',extra},current.context)
      expect(result.isError,JSON.stringify(result)).not.toBe(true)
      const legacy=await createDbMemoryStore().getIdentity(current.execution.security.access)
      const rows=await createDbMemoryStore().getIdentity(current.execution.security.access,current)
      expect(rows.map(row=>row.summary).sort()).toEqual(legacy.map(row=>row.summary).sort())
      expect(rows.map(row=>row.summary)).toEqual(expect.arrayContaining(["User's name is 42",`User's role: {"title":"Fictional planning lead"}`,'Sources: {"legacy":true}','Licenses: ["fictional",7]','Title: Fictional pilot','Domain: fictional.example','Stage: false']))
      expect(rows.some(row=>row.id.endsWith(':empty'))).toBe(false)
      noteAutomaticScopeEvidence(current.accumulator,rows)
      await expect(assertSourceModelInputAuthority(current.context)).resolves.toBeUndefined()
      const selected=(await x.f.pool.query("SELECT application_native_entity_values('person',$1::jsonb,ARRAY['profile.role']) AS role,application_native_entity_values('person',$1::jsonb,ARRAY['profile.extra']) AS extra",[{attributes:{self:true,role:extra.role,name:42,title:'Fictional pilot',email:'fictional@example.com'}}])).rows[0]
      expect(selected).toEqual({role:{'profile.role':{value:extra.role}},extra:{'profile.extra':{title:'Fictional pilot'}}})
      // Existing canonical CRM shapes are not reclassified as arbitrary extras.
      await expect(updateSelfEntityAttributes({userId:x.f.ownerId,workspaceId:x.f.workspaceId,displayName:'Fictional identity',attributes:{email:42}})).rejects.toMatchObject({code:'22023'})
    }finally{await x.cleanup()}
  })

  it('admits source-derived identity before formatting and refuses current source withdrawal without rewriting observations',async()=>{
    const x=await sourceModeFixture('internal')
    try{
      configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
      const writer=await originalMemoryAuthority(x),observed=await writer.runtime.read!('readRecord',{id:'record-1',fields:['description']})
      const floor=deriveResourceScope({producer:'identity-context',sources:observed.sources})
      const params:Parameters<typeof createEntity>[0]={kind:'person',displayName:'Fictional protected identity',workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:null,
        createdByUserId:x.f.ownerId,source:'user',sensitivity:floor.sensitivity,aliases:[],compartments:floor.compartments,projectIds:floor.projectIds,attributes:{self:true,name:'Fictional protected identity',role:'Protected planning lead'},derivation:{producer:'identity-context',sources:observed.sources}}
      const createSelf=(client:PoolClient)=>createEntity(params,client)
      const before=(await x.f.pool.query(`SELECT (SELECT count(*)::int FROM entities WHERE workspace_id=$1) AS entities,
        (SELECT count(*)::int FROM scope_derivations WHERE workspace_id=$1) AS derivations`,[x.f.workspaceId])).rows
      await expect(readRetainedContextFrame(writer,observed.sources,client=>client.query(
        'SELECT id FROM create_source_derived_entity($1::jsonb,$2::jsonb)',[JSON.stringify(params),JSON.stringify(params.derivation)]))).rejects.toMatchObject({code:'scope_source_changed',cause:{code:'42501',message:'scope_source_changed',where:expect.stringContaining('guard_external_source_derivation')}})
      expect((await x.f.pool.query(`SELECT (SELECT count(*)::int FROM entities WHERE workspace_id=$1) AS entities,
        (SELECT count(*)::int FROM scope_derivations WHERE workspace_id=$1) AS derivations`,[x.f.workspaceId])).rows).toEqual(before)
      const self=await writeRetainedContextFrame(writer,observed.sources,createSelf)
      await x.f.pool.query('UPDATE users SET entity_id=$1 WHERE id=$2',[self.id,x.f.ownerId])
      const current=await originalMemoryAuthority(x),rows=await createDbMemoryStore().getIdentity(current.execution.security.access,current)
      expect(rows.map(row=>row.summary)).toContain("User's role: Protected planning lead")
      expect(boundScopeSources(rows).some(root=>root.resourceKind==='application_field')).toBe(true)
      noteAutomaticScopeEvidence(current.accumulator,rows)
      await expect(assertSourceModelInputAuthority(current.context)).resolves.toBeUndefined()
      const observations=(await x.f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[x.f.workspaceId])).rows
      await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
      await expect(assertSourceModelInputAuthority(current.context)).rejects.toMatchObject({reason:'authority_changed'})
      const after=await originalMemoryAuthority(x)
      await expect(createDbMemoryStore().getIdentity(after.execution.security.access,after)).rejects.toMatchObject({code:'scope_source_changed'})
      expect((await x.f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[x.f.workspaceId])).rows).toEqual(observations)
    }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
  })

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
    const authority=await identityPublicationAuthority(f.ctx,accumulator)
    const derived = await writeRetainedContextFrame(authority,accumulator.evidence.sources!,client=>createMemory({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
      assistantId: f.ctx.assistantId, createdByUserId: f.ctx.userId, summary: 'Protected identity note',
      sensitivity: 'public', derivation: { producer: 'identity-context-test', sources: accumulator.evidence.sources! } },undefined,client))
    expect(derived).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], projectIds: f.ctx.projectIds })
    const edges = await pool.query('SELECT s.source_kind,s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1', [derived.id])
    expect(edges.rows).toEqual([{ source_kind: 'entity', source_id: f.entity.id }])
    await pool.query("UPDATE entities SET attributes=attributes || '{\"role\":\"Revised role\"}'::jsonb WHERE id=$1", [f.entity.id])
    expect(await getMemoryByIdSystem(derived.id)).toBeNull()
    const freshAuthority=await identityPublicationAuthority(f.ctx,accumulator)
    await expect(writeRetainedContextFrame(freshAuthority,accumulator.evidence.sources!,client=>createMemory({ workspaceId: f.ctx.workspaceId, userId: f.ctx.userId,
      assistantId: f.ctx.assistantId, createdByUserId: f.ctx.userId, summary: 'Stale identity note',
      sensitivity: 'public',
      derivation: { producer: 'identity-context-test', sources: accumulator.evidence.sources! } },undefined,client))).rejects.toMatchObject({ code: 'scope_source_changed' })
    expect((await pool.query("SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1 AND summary='Stale identity note'",[f.ctx.workspaceId])).rows).toEqual([{count:0}])
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
