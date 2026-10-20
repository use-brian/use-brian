/** Native canonical transaction composition, not a substitute CRM/task store. */
import { randomUUID, randomBytes } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { viewsRoutes, type ViewsRouteOptions } from '../../routes/views.js'
import { crmRoutes } from '../../routes/crm.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { createCrmTools, executionToolContext, boundScopeSources, type ApplicationModuleDefinition, type TaskRecord, type TaskUpdateFields,type CompanyUpdateFields,type ContactUpdateFields,type DealUpdateFields,type EntityCreateParams,type EntityUpdateFields,type EntitySupersedePatch } from '@use-brian/core'
import { ApplicationPlatformError,type ApplicationJson } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { bindTaskClosedHook, createTask, getTaskById, resolveTaskById, updateTask } from '../../db/tasks.js'
import { batchLabels,createCompany,createContact,createDeal,getCompanyById,getContactById,getDealById,listDeals,updateCompany,updateContact,updateDeal,setDealStage } from '../../db/crm.js'
import { createCrmPipeline,createCrmStage,createCrmFieldDefinition,archiveCrmFieldDefinition,updateCrmCustomFields,setCrmArchived,setCrmDealPipelineStage,getCrmConfig,addCrmDealParticipant,removeCrmDealParticipant } from '../../db/crm-r2.js'
import { createEntity, supersedeEntity, updateEntity } from '../../db/entities-store.js'
import { createDbCrmStore } from '../../db/crm-store.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { findAssistantById } from '../../db/users.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] canonical native operation composition', () => {
  const owner = getPool(), workspaceId = randomUUID(), userId = randomUUID(), readerId = randomUUID(), assistantId = randomUUID()
  const access = { workspaceId, userId, assistantId, assistantKind: 'primary' as const }
  const fixtureUsers:string[]=[userId,readerId],fixtureOAuthClients:string[]=[]
  beforeAll(async () => {
    for (const id of [userId,readerId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native operations',$2,false)", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspaceId,readerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional native operator',$2,$3,'primary','confidential')", [assistantId,userId,workspaceId])
  })
  afterAll(async () => {
    bindTaskClosedHook(null)
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    if(fixtureOAuthClients.length) await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])',[fixtureOAuthClients])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [fixtureUsers])
    await getAppPool().end(); await owner.end()
  })
  const version = (task: TaskRecord) => boundScopeSources(task)[0].version!
  const task = (title = `Fictional operation ${randomUUID()}`, parentId?: string) => createTask(userId, { workspaceId, title, parentId, access })
  async function client() {
    const connection = await getAppPool().connect()
    await connection.query('BEGIN'); await applyRLSGucs(connection,userId)
    expect((await connection.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
      FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)).rows[0].bypass).toBe(false)
    return connection
  }
  async function execution() {
    return (await resolveExecutionContextSystem({ userId, workspaceId, assistant: (await findAssistantById(assistantId))!, memberMode: 'member',
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, lifecycle: { sessionId: randomUUID(), sessionPersisted: false,
        channelId: 'native-operation-fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
  }
  it('Q02/Q08 preserves mixed native member labels, canonical evidence, duplicate groups and the bounded batch limit',async()=>{
    const company=await createCompany(userId,{workspaceId,name:'Fictional native label company',access}),contact=await createContact(userId,{workspaceId,name:'Fictional native label contact',access}),deal=await createDeal(userId,{workspaceId,access})
    const labels=await batchLabels(access,[{entity:'company',ids:[company.id,company.id]},{entity:'company',ids:[company.id]},{entity:'contact',ids:[contact.id]},{entity:'deal',ids:[deal.id]},{entity:'deal',ids:[]}])
    expect([...labels]).toEqual([[`company:${company.id}`,company.name],[`contact:${contact.id}`,contact.name],[`deal:${deal.id}`,`Deal #${deal.id.slice(0,8)}`]])
    expect(boundScopeSources(labels).some(source=>source.resourceKind==='application_field')).toBe(true)
    const empty=await batchLabels(access,[{entity:'company',ids:[randomUUID()]}]);expect(empty.size).toBe(0);expect(boundScopeSources(empty).length).toBeGreaterThan(0)
    await expect(batchLabels(access,[{entity:'company',ids:Array.from({length:100},()=>randomUUID())},{entity:'contact',ids:[randomUUID()]}])).rejects.toMatchObject({code:'invalid_value'})
    await expect(batchLabels(access,[{entity:'company',ids:Array.from({length:101},()=>randomUUID())}])).rejects.toMatchObject({code:'invalid_value'})
  })
  it.each([{type:'company',field:'domain',canonical:'fictional.example'},{type:'person',field:'email',canonical:'fictional@example.com'}] as const)('Q02 preserves the canonical $field fallback and field evidence through legacy get',async({type,field,canonical})=>{
    const value=await createEntity({workspaceId,kind:type,canonicalId:canonical,displayName:'Fictional native point fallback',attributes:{},createdByUserId:userId,source:'user'})
    const record=type==='company'?await getCompanyById(access,value.id):await getContactById(access,value.id)
    expect(record).toMatchObject({id:value.id,entityId:value.id,workspaceId,name:value.displayName,[field]:canonical,aliases:[],tags:[],externalRef:{}})
    expect(record?.createdAt).toEqual(value.createdAt);expect(record?.updatedAt).toEqual(value.updatedAt)
    expect(boundScopeSources(record!)).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'application_field',workspaceId})]))
  })
  it.each(['company','person'] as const)('Q02/Q08 preserves admitted historical null containers in the legacy %s DTO',async type=>{
    const value=await createEntity({workspaceId,kind:type,displayName:'Fictional nullable legacy containers',attributes:{},createdByUserId:userId,source:'user'})
    const fixture=await owner.connect()
    try {
      await fixture.query('BEGIN');await fixture.query('ALTER TABLE entities DISABLE TRIGGER application_native_entity_values')
      await fixture.query('UPDATE entities SET attributes=$2 WHERE id=$1',[value.id,{tags:null,external_ref:null}])
      await fixture.query('ALTER TABLE entities ENABLE TRIGGER application_native_entity_values');await fixture.query('COMMIT')
    } finally {await fixture.query('ROLLBACK');fixture.release()}
    const result=type==='company'?await getCompanyById(access,value.id):await getContactById(access,value.id)
    expect(result).toMatchObject({id:value.id,tags:[],externalRef:{}})
    expect(boundScopeSources(result!)).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'application_field',workspaceId})]))
    expect((await owner.query('SELECT attributes FROM entities WHERE id=$1',[value.id])).rows[0].attributes).toEqual({tags:null,external_ref:null})
  })
  it.each([
    {label:'safe numeric',amount:12,expected:12},
    {label:'string',amount:'12',expected:'12'},
    {label:'exact decimal',amount:'9007199254740993.000000000000000001',expected:'9007199254740993.000000000000000001'},
    {label:'historical numeric',amount:12,storedNumeric:'9007199254740993.000000000000000001',expected:'9007199254740993.000000000000000001'},
    {label:'admitted null',amount:null,expected:null,historicalNull:true},
  ])('Q02/Q05 preserves canonical legacy deal encoding and evidence for $label amounts',async value=>{
    const deal=value.historicalNull
      ? await createEntity({workspaceId,kind:'deal',displayName:'Fictional historical nullable deal',attributes:{},createdByUserId:userId,source:'user'})
      : await createDeal(userId,{workspaceId,access,amount:value.amount,stage:'proposal',closeDate:new Date('2026-03-18')})
    if(value.storedNumeric)await owner.query("UPDATE entities SET attributes=jsonb_set(attributes,'{amount}',to_jsonb($2::numeric)) WHERE id=$1",[deal.id,value.storedNumeric])
    const source=(await owner.query('SELECT created_at,updated_at FROM entities WHERE id=$1',[deal.id])).rows[0]
    const result=await getDealById(access,deal.id)
    expect(result).toMatchObject({id:deal.id,entityId:deal.id,workspaceId,amount:value.expected,stage:value.historicalNull?'lead':'proposal',companyId:null,contactId:null,closeDate:value.historicalNull?null:new Date('2026-03-18')})
    expect(result?.createdAt).toEqual(source.created_at);expect(result?.updatedAt).toEqual(source.updated_at)
    expect(Object.hasOwn(result!,'tags')).toBe(false)
    expect(boundScopeSources(result!)).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'application_field',workspaceId})]))
  })
  it.each(['company','person','deal'] as const)('Q02 excludes unselected malformed native %s slots before actual member reads and queries',async type=>{
    const value=await createEntity({workspaceId,kind:type,displayName:`Fictional native selected ${randomUUID()}`,attributes:{},createdByUserId:userId,source:'user'})
    const fixture=await owner.connect()
    try {
      await fixture.query('BEGIN');await fixture.query('ALTER TABLE entities DISABLE TRIGGER application_native_entity_values')
      await fixture.query('UPDATE entities SET attributes=$2 WHERE id=$1',[value.id,{crm_archived_at:'invalid historical timestamp'}])
      await fixture.query('ALTER TABLE entities ENABLE TRIGGER application_native_entity_values');await fixture.query('COMMIT')
    } finally {await fixture.query('ROLLBACK');fixture.release()}
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),context=await execution()
    const record=await dispatcher.query(context,'native','get',{type,id:value.id,fields:['name']}) as {values:unknown}
    expect(record.values).toEqual({name:value.displayName});expect(boundScopeSources(record).length).toBeGreaterThan(0)
    expect((await dispatcher.query(context,'native','get',{type,id:value.id,fields:[]}) as {values:unknown}).values).toEqual({})
    const result=await dispatcher.query(context,'native','query',{type,query:{fields:['name'],filters:[{field:'name',op:'eq',value:value.displayName}]}}) as {records:Array<{ref:{id:string}}>}
    expect(result.records.map(row=>row.ref.id)).toEqual([value.id])
    await expect(dispatcher.query(context,'native','get',{type,id:value.id,fields:['archivedAt']})).rejects.toMatchObject({code:'invalid_value'})
    const legacy=type==='company'?await getCompanyById(access,value.id):type==='person'?await getContactById(access,value.id):null
    if(type!=='deal')expect(legacy?.id).toBe(value.id)
  })
  it('Q02 queries native CRM under the actual member and rejects an owner-pool query catalog',async()=>{
    const name=`Fictional native member query ${randomUUID()}`,value=await createCompany(userId,{workspaceId,name,access,mergeByName:false})
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const result=await dispatcher.query(await execution(),'native','query',{type:'company',query:{fields:['name'],filters:[{field:'name',op:'eq',value:name}]}}) as {records:Array<{ref:{id:string};values:unknown}>}
    expect(result.records).toEqual([expect.objectContaining({ref:expect.objectContaining({id:value.id}),values:{name}})])
    expect(boundScopeSources(result).length).toBeGreaterThan(1)
    const connection=await owner.connect();try{await connection.query('BEGIN');await applyRLSGucs(connection,userId)
      expect((await connection.query("SELECT application_native_query_catalog($1,'company') AS value",[workspaceId])).rows[0].value).toBeNull()
    }finally{await connection.query('ROLLBACK');connection.release()}
  })
  it('Q02 captures selected native values under the actual member while refusing an owner-pool read',async()=>{
    const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional selected native member fields',
      aliases:['Fictional member alias'],attributes:{tags:['member-tag'],external_ref:{provider:'fictional',id:'member-reference'}},
      createdByUserId:userId,source:'user'})
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const projection=await dispatcher.query(await execution(),'native','get',{type:'company',id:value.id,
      fields:['name','tags','aliases','externalRef','createdAt','updatedAt']}) as {values:Record<string,unknown>;fields:string[]}
    expect(projection.values).toMatchObject({name:value.displayName,tags:['member-tag'],aliases:['fictional member alias'],
      externalRef:{provider:'fictional',id:'member-reference'},createdAt:value.createdAt.toISOString(),updatedAt:value.updatedAt.toISOString()})
    expect(boundScopeSources(projection)).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'application_field',workspaceId})]))
    const empty=await dispatcher.query(await execution(),'native','get',{type:'company',id:value.id,fields:[]}) as {values:unknown;fields:string[]}
    expect(empty.values).toEqual({});expect(empty.fields).toEqual([]);expect(boundScopeSources(empty).length).toBeGreaterThan(0)
    expect((await owner.query('SELECT read_native_application_record($1,$2,$3,$4) AS value',[workspaceId,'company',value.id,['name']])).rows[0].value).toBeNull()
  })
  it('Q02 refuses the canonical native read port on an owner connection even with a real member GUC',async()=>{
    const value=await createCompany(userId,{workspaceId,name:'Fictional owner connection boundary',access,mergeByName:false})
    const privileged=await owner.connect()
    try {
      await privileged.query('BEGIN');await applyRLSGucs(privileged,userId)
      expect((await privileged.query('SELECT read_native_application_record($1,$2,$3,$4) AS value',[workspaceId,'company',value.id,['name']])).rows[0].value).toBeNull()
    } finally {await privileged.query('ROLLBACK');privileged.release()}
  })
  it.each([
    {kind:'person',field:'company_id',target:'missing'},
    {kind:'deal',field:'company_id',target:'missing'},
    {kind:'deal',field:'contact_id',target:'missing'},
    {kind:'person',field:'company_id',target:'wrong_kind'},
    {kind:'deal',field:'contact_id',target:'wrong_kind'},
    {kind:'person',field:'company_id',target:'archived'},
    {kind:'deal',field:'contact_id',target:'archived'},
    {kind:'person',field:'company_id',target:'foreign_workspace'},
    {kind:'deal',field:'contact_id',target:'foreign_workspace'},
  ] as const)('Q04 refuses a raw canonical $kind $field assignment to a $target target',async({kind,field,target})=>{
    const source=await createEntity({workspaceId,kind,displayName:'Fictional raw relationship source',createdByUserId:userId,source:'user'})
    let targetId:string=randomUUID(),foreign:string|undefined
    if(target!=='missing') {
      let targetWorkspace:string=workspaceId
      if(target==='foreign_workspace') {
        foreign=randomUUID();targetWorkspace=foreign
        await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional other relationship workspace',$2)",[foreign,userId])
        await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[foreign,userId])
      }
      const targetKind=target==='wrong_kind'?(field==='company_id'?'person':'company'):(field==='company_id'?'company':'person')
      targetId=(await createEntity({workspaceId:targetWorkspace,kind:targetKind,displayName:'Fictional raw relationship target',
        attributes:target==='archived'?{crm_archived_at:new Date().toISOString()}:{},createdByUserId:userId,source:'user'})).id
    }
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0],connection=await client()
    try {
      await expect(connection.query('UPDATE entities SET attributes=jsonb_set(attributes,ARRAY[$2],to_jsonb($3::text)) WHERE id=$1',[source.id,field,targetId])).rejects.toMatchObject({code:'42501'})
    } finally {await connection.query('ROLLBACK');connection.release();if(foreign) await owner.query('DELETE FROM workspaces WHERE id=$1',[foreign])}
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]).toEqual(before)
  })
  it.each(['created_by_user_id','created_by_assistant_id','created_at','id'] as const)(
    'Q04 refuses raw rewrites of canonical native managed identity: %s',async field=>{
    const value=await createCompany(userId,{workspaceId,name:`Fictional immutable native identity ${randomUUID()}`,access,mergeByName:false})
    const before=(await owner.query('SELECT id,created_by_user_id,created_by_assistant_id,created_at,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    const assignment=field==='created_by_user_id'?readerId:field==='created_by_assistant_id'?assistantId:field==='created_at'?'2000-01-01T00:00:00.000Z':randomUUID()
    const connection=await client()
    try {await expect(connection.query(`UPDATE entities SET ${field}=$2 WHERE id=$1`,[value.id,assignment])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT id,created_by_user_id,created_by_assistant_id,created_at,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each(['sensitivity','private'] as const)('Q04 refuses a raw relationship that would publish a target %s floor',async floor=>{
    const target=await createEntity({workspaceId,kind:'company',displayName:'Fictional protected relationship target',createdByUserId:userId,
      source:'user',...(floor==='sensitivity'?{sensitivity:'confidential' as const}:{userId})})
    const source=await createContact(userId,{workspaceId,name:'Fictional broader relationship source',access}),connection=await client()
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]
    try {await expect(connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{company_id}',to_jsonb($2::text)) WHERE id=$1",[source.id,target.id])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]).toEqual(before)
  })
  it('Q04/Q05 permits a current raw relationship with its complete scope and refuses later declassification',async()=>{
    const target=await createEntity({workspaceId,kind:'company',displayName:'Fictional scoped raw target',createdByUserId:userId,source:'user',sensitivity:'confidential',userId})
    const source=await createEntity({workspaceId,kind:'person',displayName:'Fictional scoped raw source',createdByUserId:userId,source:'user',sensitivity:'confidential',userId})
    const connection=await client()
    try {await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{company_id}',to_jsonb($2::text)) WHERE id=$1",[source.id,target.id]);await connection.query('COMMIT')}
    finally {await connection.query('ROLLBACK');connection.release()}
    const before=(await owner.query('SELECT attributes,sensitivity,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]
    expect(before.attributes.company_id).toBe(target.id)
    const other=await client()
    try {await expect(other.query("UPDATE entities SET sensitivity='internal' WHERE id=$1",[source.id])).rejects.toMatchObject({code:'42501'})}
    finally {await other.query('ROLLBACK');other.release()}
    expect((await owner.query('SELECT attributes,sensitivity,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]).toEqual(before)
  })
  it('Q04 refuses an unregistered member owner reference at the canonical raw writer',async()=>{
    const source=await createCompany(userId,{workspaceId,name:'Fictional raw member owner source',access,mergeByName:false}),connection=await client()
    try {await expect(connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{owner_id}',to_jsonb($2::text)) WHERE id=$1",[source.id,randomUUID()])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT attributes FROM entities WHERE id=$1',[source.id])).rows[0].attributes).not.toHaveProperty('owner_id')
  })
  it.each(['pipeline_id','pipeline_stage_id'] as const)('Q04 refuses missing native configuration references: %s',async field=>{
    const source=await createDeal(userId,{workspaceId,access}),connection=await client()
    try {await expect(connection.query('UPDATE entities SET attributes=jsonb_set(attributes,ARRAY[$2],to_jsonb($3::text)) WHERE id=$1',[source.id,field,randomUUID()])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT attributes FROM entities WHERE id=$1',[source.id])).rows[0].attributes).not.toHaveProperty(field)
  })
  it('Q04 refuses an inconsistent canonical pipeline and stage pair',async()=>{
    await getCrmConfig(userId,workspaceId)
    const first=await createCrmPipeline({workspaceId,userId,name:'Fictional first raw pipeline'}),second=await createCrmPipeline({workspaceId,userId,name:'Fictional second raw pipeline'})
    const stage=(await createCrmStage({workspaceId,userId,pipelineId:second.id,name:'Fictional raw stage',category:'open',probability:25}))!
    const source=await createDeal(userId,{workspaceId,access}),connection=await client()
    try {await expect(connection.query("UPDATE entities SET attributes=attributes||jsonb_build_object('pipeline_id',$2::text,'pipeline_stage_id',$3::text) WHERE id=$1",[source.id,first.id,stage.id])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT attributes FROM entities WHERE id=$1',[source.id])).rows[0].attributes).not.toHaveProperty('pipeline_id')
  })
  it.each(['missing','wrong_kind'] as const)('Q04 validates current custom reference targets below raw writers: %s',async mode=>{
    const definition=await createCrmFieldDefinition({workspaceId,userId,entityKind:'company',fieldKey:`raw_ref_${mode}`,label:'Fictional raw relation',fieldType:'entity_reference',options:['company']})
    if(!definition) throw new Error('Fictional raw reference definition was not created.')
    const source=await createCompany(userId,{workspaceId,name:'Fictional raw custom source',access,mergeByName:false})
    const target=mode==='missing'?randomUUID():(await createContact(userId,{workspaceId,name:'Fictional wrong custom target',access})).id
    const connection=await client()
    try {
      await expect(connection.query("UPDATE entities SET attributes=attributes||jsonb_build_object('custom_fields',jsonb_build_object($2::text,$3::text)) WHERE id=$1",[source.id,definition.fieldKey,target])).rejects.toMatchObject({code:'42501'})
    } finally {await connection.query('ROLLBACK');connection.release();await archiveCrmFieldDefinition(userId,workspaceId,definition.id)}
  })
  it('Q04/Q05 retains an archived custom reference privacy floor without blocking unrelated partial edits',async()=>{
    const definition=await createCrmFieldDefinition({workspaceId,userId,entityKind:'company',fieldKey:'archived_raw_ref',label:'Fictional archived reference',fieldType:'entity_reference',options:['company']})
    if(!definition) throw new Error('Fictional archived reference definition was not created.')
    const target=await createCompany(userId,{workspaceId,name:'Fictional confidential retained target',sensitivity:'confidential',access,mergeByName:false})
    const source=await createCompany(userId,{workspaceId,name:'Fictional archived reference source',customFields:{[definition.fieldKey]:target.id},access,mergeByName:false})
    await archiveCrmFieldDefinition(userId,workspaceId,definition.id)
    expect(await updateCompany(userId,source.id,{domain:'fictional.example'},access)).toMatchObject({id:source.id,domain:'fictional.example'})
    const before=(await owner.query('SELECT attributes,sensitivity,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]
    expect(before.sensitivity).toBe('confidential');expect(before.attributes.custom_fields[definition.fieldKey]).toBe(target.id)
    const connection=await client()
    try {await expect(connection.query("UPDATE entities SET sensitivity='internal' WHERE id=$1",[source.id])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT attributes,sensitivity,scope_version::text AS version FROM entities WHERE id=$1',[source.id])).rows[0]).toEqual(before)
  })
  it('Q05 preserves an untouched archived reference during a typed unrelated partial edit',async()=>{
    const company=await createCompany(userId,{workspaceId,name:'Fictional archived relationship target',access,mergeByName:false})
    const source=await createContact(userId,{workspaceId,name:'Fictional retained relationship source',companyId:company.id,access})
    await setCrmArchived({ctx:access,entityId:company.id,archived:true})
    expect(await updateContact(userId,source.id,{phone:'555-0199'},undefined,access)).toMatchObject({id:source.id,phone:'555-0199',companyId:company.id})
  })
  it('Q04 refuses moving a canonical native row between two otherwise authorized workspaces',async()=>{
    const foreign=randomUUID(),value=await createCompany(userId,{workspaceId,name:'Fictional fixed workspace source',access,mergeByName:false})
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional writable other workspace',$2)",[foreign,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[foreign,userId])
    const connection=await client()
    try {await expect(connection.query('UPDATE entities SET workspace_id=$2 WHERE id=$1',[value.id,foreign])).rejects.toMatchObject({code:'42501'})}
    finally {await connection.query('ROLLBACK');connection.release();await owner.query('DELETE FROM workspaces WHERE id=$1',[foreign])}
    expect((await owner.query('SELECT workspace_id FROM entities WHERE id=$1',[value.id])).rows[0].workspace_id).toBe(workspaceId)
  })
  it.each([['Unnormalized alias'],[' alias'],['alias','alias'],[null]].map(aliases=>({aliases})))('Q04 refuses invalid raw canonical aliases: $aliases',async({aliases})=>{
    const value=await createCompany(userId,{workspaceId,name:'Fictional raw aliases',access,mergeByName:false}),connection=await client()
    try {await expect(connection.query('UPDATE entities SET aliases=$2::text[] WHERE id=$1',[value.id,aliases])).rejects.toMatchObject({code:'22023'})}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await owner.query('SELECT aliases FROM entities WHERE id=$1',[value.id])).rows[0].aliases).toEqual([])
  })
  it('Q03/Q04 preserves assigned legacy Department membership for native relationship writes',async()=>{
    const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(userId,workspaceId,{name:'Fictional reference Department',key:'fictional-reference-department'})
    await groups.addMember(userId,team.id,readerId)
    const projectId=randomUUID();await owner.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fictional relation project','fictional relation project',$3)",[projectId,workspaceId,userId])
    const before=(await owner.query('SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,readerId])).rows[0].team_scope_mode
    await owner.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,readerId])
    try {
      const target=await createCompany(userId,{workspaceId,name:'Fictional classified Department company',sensitivity:'confidential',compartments:[team.compartmentKey!],projectIds:[projectId]})
      const probe=await getAppPool().connect()
      try {
        await probe.query('BEGIN');await applyRLSGucs(probe,readerId)
        // The legacy native write is valid; the independent derived-payload
        // reader still requires Project membership and must remain held.
        expect((await probe.query("SELECT read_admitted_native_scope_snapshot($1,'entity',$2) AS scope",[workspaceId,target.id])).rows[0].scope).toEqual({held:true})
      } finally {await probe.query('ROLLBACK');probe.release()}
      const contact=await createContact(readerId,{workspaceId,name:'Fictional Department contact',companyId:target.id})
      expect(contact).toMatchObject({companyId:target.id,sensitivity:'confidential',compartments:[team.compartmentKey!],projectIds:[projectId]})
    } finally {await owner.query('UPDATE workspace_members SET team_scope_mode=$3 WHERE workspace_id=$1 AND user_id=$2',[workspaceId,readerId,before])}
  })
  it('Q05 rolls back task supersession, child and Goal links without early lifecycle effects', async () => {
    const parent = await task(), child = await task('Fictional linked child',parent.id)
    const goal = (await owner.query(`INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,means,status,created_by_user_id,confirmed_at)
      VALUES($1,'task',$2,'Fictional linked outcome','{"kind":"subtasks"}','{}','active',$3,now()) RETURNING id`, [workspaceId,parent.id,userId])).rows[0].id
    const connection = await client(), effects: Array<() => void> = [], closed: string[] = []
    bindTaskClosedHook(value => closed.push(value.id))
    try {
      const updated = await updateTask(userId,parent.id,{ title: 'Fictional uncommitted successor',status: 'done' },undefined,{ access,expectedVersion: version(parent) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(updated).not.toBeNull(); expect(updated!.id).not.toBe(parent.id)
      expect(version(updated!)).toBe(String(BigInt(version(parent))+1n))
      expect((await connection.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(updated!.id)
      expect((await connection.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
      expect(closed).toEqual([]); expect(effects).toHaveLength(1)
      await connection.query('ROLLBACK')
      expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[parent.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
      expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(parent.id)
      expect((await owner.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(parent.id)
      expect((await owner.query('SELECT id FROM tasks WHERE id=$1',[updated!.id])).rows).toEqual([])
      expect(closed).toEqual([])
    } finally { await connection.query('ROLLBACK'); connection.release(); bindTaskClosedHook(null) }
  })
  it('Q05 composes the canonical entity-backed company and task writers in one commit', async () => {
    const company = await createCompany(userId,{ workspaceId,name: `Fictional company ${randomUUID()}`,access,mergeByName: false }), before = await task()
    const connection = await client(), effects: Array<() => void> = []
    try {
      const changedCompany = await updateCompany(userId,company.id,{ name: 'Fictional revised company' },access,connection)
      const changedTask = await updateTask(userId,before.id,{ title: 'Fictional revised work' },undefined,{ access,expectedVersion: version(before) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(changedCompany?.id).toBe(company.id)
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe(company.name)
      expect((await owner.query('SELECT valid_to FROM tasks WHERE id=$1',[before.id])).rows[0].valid_to).toBeNull()
      await connection.query('COMMIT'); for (const effect of effects) effect()
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe('Fictional revised company')
      expect((await getTaskById(access,changedTask!.id))?.title).toBe('Fictional revised work')
      expect(version(changedTask!)).toBe(String(BigInt(version(before))+1n))
    } finally { await connection.query('ROLLBACK'); connection.release() }
  })
  it('Q05 lets exactly one canonical CAS writer win and refuses a stale predecessor precondition', async () => {
    const before = await task()
    const results = await Promise.allSettled(['Fictional first edit','Fictional second edit'].map(title =>
      updateTask(userId,before.id,{ title },undefined,{ access,expectedVersion: version(before) })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.code).toBe('record_version_conflict')
    expect((await owner.query('SELECT id FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL AND title=ANY($2::text[])',[workspaceId,['Fictional first edit','Fictional second edit']])).rows).toHaveLength(1)
  })
  it.each([{ unknown: 'not a field' },{ title: '' },{ status: 'invented' },{ due: 'not a Date' }])('Q04 refuses invalid native patch %j at the canonical writer', async fields => {
    const before = await task()
    await expect(updateTask(userId,before.id,fields as TaskUpdateFields,undefined,{ access })).rejects.toMatchObject({ code: 'invalid_value' })
    expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[before.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
  })
  it('Q05 serializes canonical CRM attribute merges and keeps business changes outside metadata epochs',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional merge ${randomUUID()}`,access,mergeByName:false})
    const invocation=await execution()
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const results=await Promise.all([
      updateCompany(userId,company.id,{domain:'fictional.example'},access),
      updateCompany(userId,company.id,{tags:['fictional-category']},access),
    ])
    expect(results.every(value => value?.id===company.id)).toBe(true)
    const current=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current.attributes).toMatchObject({domain:'fictional.example',tags:['fictional-category']})
    expect(current.version).toBe(String(BigInt(before)+2n))
    await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
  })
  it('Q05 admits one canonical CRM CAS edit and preserves its ID and references on stale refusal',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional CAS ${randomUUID()}`,access,mergeByName:false})
    const contact=await createContact(userId,{workspaceId,name:'Fictional linked contact',companyId:company.id,access})
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const outcomes=await Promise.allSettled(['Fictional CAS first','Fictional CAS second'].map(name =>
      updateCompany(userId,company.id,{name},access,undefined,undefined,{expectedVersion:before})))
    expect(outcomes.filter(outcome => outcome.status==='fulfilled')).toHaveLength(1)
    const denied=outcomes.find(outcome => outcome.status==='rejected')
    expect(denied?.status==='rejected' && denied.reason.code).toBe('record_version_conflict')
    const current=(await owner.query('SELECT id,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current).toEqual({id:company.id,version:String(BigInt(before)+1n)})
    expect((await owner.query("SELECT attributes->>'company_id' AS company FROM entities WHERE id=$1",[contact.id])).rows[0].company).toBe(company.id)
    await expect(updateCompany(userId,company.id,{domain:'stale.example'},access,undefined,undefined,{expectedVersion:before})).rejects.toMatchObject({code:'record_version_conflict'})
    expect((await owner.query("SELECT attributes ? 'domain' AS present FROM entities WHERE id=$1",[company.id])).rows[0].present).toBe(false)
  })
  it('Q04 refuses immutable and invalid create keys through every typed canonical CRM writer',async () => {
    const invalid=await Promise.allSettled([
      createCompany(userId,{workspaceId,name:'Fictional creation',access,immutableId:randomUUID()} as Parameters<typeof createCompany>[1]),
      createContact(userId,{workspaceId,name:'Fictional creation',access,phone:17} as unknown as Parameters<typeof createContact>[1]),
      createDeal(userId,{workspaceId,access,stage:'invented'} as unknown as Parameters<typeof createDeal>[1]),
    ])
    expect(invalid.every(outcome => outcome.status==='rejected' && outcome.reason.code==='invalid_value')).toBe(true)
    expect((await owner.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Fictional creation'",[workspaceId])).rows).toEqual([])
  })
  it('Q05 serializes the legacy stage writer with canonical field patches',async () => {
    const deal=await createDeal(userId,{workspaceId,access})
    const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0].version
    await Promise.all([setDealStage(userId,deal.id,'won',access),updateDeal(userId,deal.id,{amount:42},undefined,access)])
    expect((await owner.query("SELECT attributes->>'stage' AS stage,attributes->>'amount' AS amount FROM entities WHERE id=$1",[deal.id])).rows[0]).toEqual({stage:'won',amount:'42'})
    await expect(setDealStage(userId,deal.id,'lost',access,undefined,undefined,{expectedVersion:version})).rejects.toMatchObject({code:'record_version_conflict'})
  })
  it.each([
    { kind: 'company',fields: { invented: 'unregistered field' } },
    { kind: 'company',fields: { name: '' } },
    { kind: 'company',fields: { domain: 17 } },
    { kind: 'company',fields: { tags: ['valid',17] } },
    { kind: 'person',fields: { phone: { invalid: 'object' } } },
    { kind: 'person',fields: { companyId: 'not-a-uuid' } },
    { kind: 'deal',fields: { amount: Number.POSITIVE_INFINITY } },
    { kind: 'deal',fields: { closeDate: new Date('not-a-date') } },
    { kind: 'deal',fields: { stage: 'won' } },
  ])('Q04 refuses invalid canonical CRM $kind patch before changing storage: $fields',async ({kind,fields}) => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional validation ${randomUUID()}`,access,mergeByName:false})
    const record=kind==='company' ? company : kind==='person' ? await createContact(userId,{workspaceId,name:'Fictional contact',access})
      : await createDeal(userId,{workspaceId,companyId:company.id,access})
    const before=(await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]
    const write=kind==='company' ? () => updateCompany(userId,record.id,fields as CompanyUpdateFields,access)
      : kind==='person' ? () => updateContact(userId,record.id,fields as ContactUpdateFields,undefined,access)
      : () => updateDeal(userId,record.id,fields as DealUpdateFields,undefined,access)
    await expect(write()).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
  })
  it('Q06 commits a registered multi-task command and its receipt/audit/outbox exactly once, with complete rollback on refusal', async () => {
    const first = await task(), second = await task(), input = z.object({ ids: z.array(z.string().uuid()).length(2),versions: z.array(z.string()).length(2),title: z.string().min(1) }).strict()
    const module: ApplicationModuleDefinition<PoolClient> = { key: 'native_operation_fixture',defaultState: 'enabled',application: {
      version: '1',dependencies: [],resources: [],queries: [],commands: ['rename_pair'],events: ['native_operation_fixture.changed'],policyCapabilities: [],backgroundHandlers: [],uiContributions: [] },queries: {},commands: {
      rename_pair: { input,eventKey: 'native_operation_fixture.changed',authorize: async (context,raw) => {
        for (const id of input.parse(raw).ids) if (!await resolveTaskById(context.execution.security.access,id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      },execute: async (context,raw) => {
        const value = input.parse(raw),refs = []
        for (const [index,id] of value.ids.entries()) {
          const updated = await updateTask(userId,id,{ title: value.title },undefined,{ access: context.execution.security.access,expectedVersion: value.versions[index] },
            { client: context.transaction,afterCommit: context.afterCommit })
          if (!updated) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
          refs.push({ workspaceId,origin: { kind: 'native' as const,moduleKey: 'native' },typeKey: 'task',id: updated.id,version: version(updated) })
        }
        return refs
      },authorizeResult: async (context,refs) => {
        for (const ref of refs) if (!await getTaskById(context.execution.security.access,ref.id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      } },
    } }
    const service = new ApplicationPlatformService([module]), identity = await execution(), key = randomUUID()
    const failed = { idempotencyKey: key,input: { ids: [first.id,second.id],versions: [version(first),'999'],title: 'Fictional rolled back pair' } }
    await expect(service.command(identity,module.key,'rename_pair',failed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect((await owner.query('SELECT id FROM tasks WHERE id=ANY($1::uuid[]) AND valid_to IS NULL',[[first.id,second.id]])).rows).toHaveLength(2)
    expect((await owner.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1',[key])).rows).toEqual([])
    const command = { idempotencyKey: randomUUID(),input: { ids: [first.id,second.id],versions: [version(first),version(second)],title: 'Fictional committed pair' } }
    const committed = await service.command(identity,module.key,'rename_pair',command), replay = await service.command(identity,module.key,'rename_pair',command)
    expect(replay.id).toBe(committed.id); expect(committed.resources).toHaveLength(2)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT resources::text FROM application_operation_receipts WHERE id=$1',[committed.id])).rows[0].resources).not.toContain('Fictional committed pair')
    // Replay is governed by current native visibility; another actual member
    // retains access to the same source after this caller loses its audience.
    await owner.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[committed.resources[0].id,readerId])
    await expect(service.command(identity,module.key,'rename_pair',command)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(await getTaskById({ ...access,userId: readerId },committed.resources[0].id)).not.toBeNull()
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
  })
  it.each([
    {unexpected:true},{createdByUserId:'forged-creation-metadata'},{displayName:42},{attributes:[]},
    {attributes:{invalid:NaN}},{attributes:{invalid:Infinity}},{verifiedAt:new Date('invalid')},{sensitivity:'undeclared'},
  ])('Q04 refuses an invalid raw canonical entity patch frame without changing storage: %j',async fields => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional frame ${randomUUID()}`,access,mergeByName:false})
    const before=(await owner.query('SELECT display_name,attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(updateEntity(userId,value.id,fields as EntityUpdateFields,access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([{unexpected:true},{id:'caller-forged-id'},{aliases:[17]},{source:'undeclared'},{attributes:{invalid:NaN}},{displayName:'   '}])
  ('Q04 refuses an invalid raw canonical entity create frame without a row: %j',async fields => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind:'company',displayName:'Fictional invalid frame',workspaceId,createdByUserId:userId,source:'user',...fields} as EntityCreateParams))
      .rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it.each([{unexpected:true},{attributes:{invalid:Infinity}},{displayName:42}])
  ('Q04 refuses an invalid raw canonical supersession frame without retiring its source: %j',async fields => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional successor ${randomUUID()}`,access,mergeByName:false})
    const before=(await owner.query('SELECT display_name,attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(supersedeEntity(userId,value.id,{attributes:{},...fields} as EntitySupersedePatch)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([
    {label:'company domain scalar',kind:'company',attributes:{domain:17}},
    {label:'company tags array',kind:'company',attributes:{tags:'invented'}},
    {label:'contact email scalar',kind:'person',attributes:{email:{invented:true}}},
    {label:'contact phone scalar',kind:'person',attributes:{phone:17}},
    {label:'contact company UUID',kind:'person',attributes:{company_id:'not-a-uuid'}},
    {label:'deal stage enum',kind:'deal',attributes:{stage:'invented'}},
    {label:'negative deal decimal',kind:'deal',attributes:{amount:'-1'}},
    {label:'exponent deal decimal',kind:'deal',attributes:{amount:'1e8'}},
    {label:'deal decimal shape',kind:'deal',attributes:{amount:false}},
    {label:'deal invalid close date',kind:'deal',attributes:{close_date:'2026-02-30'}},
    {label:'deal company UUID',kind:'deal',attributes:{company_id:'not-a-uuid'}},
    {label:'deal contact UUID',kind:'deal',attributes:{contact_id:'not-a-uuid'}},
  ].flatMap(value => ['entity writer','raw nonowner SQL'].map(writer => ({...value,writer}))))
  ('Q04 refuses invalid $label through the $writer without changing its canonical version',async ({kind,attributes,writer}) => {
    const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional value ${randomUUID()}`,access,mergeByName:false})
      :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional value contact',access}):await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    const patch={...before.attributes,...attributes}
    if(writer==='entity writer') await expect(updateEntity(userId,value.id,{attributes:patch},access)).rejects.toThrow('invalid_value')
    else {
      const transaction=await client()
      try {await expect(transaction.query('UPDATE entities SET attributes=$2::jsonb WHERE id=$1',[value.id,patch])).rejects.toMatchObject({code:'22023'})}
      finally {await transaction.query('ROLLBACK');transaction.release()}
    }
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([{kind:'company',attributes:{domain:17}},{kind:'person',attributes:{email:[]}},
    {kind:'deal',attributes:{stage:'invented'}},{kind:'deal',attributes:{amount:'-1'}}])
  ('Q04 refuses malformed native $kind attributes during raw canonical creation',async ({kind,attributes}) => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind,displayName:'Fictional invalid business value',workspaceId,createdByUserId:userId,source:'user',attributes} as EntityCreateParams))
      .rejects.toThrow('invalid_value')
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it.each([
    {fieldType:'text' as const,value:17,options:[]},
    {fieldType:'number' as const,value:'1',options:[]},
    {fieldType:'date' as const,value:'2026-02-30',options:[]},
    {fieldType:'boolean' as const,value:0,options:[]},
    {fieldType:'single_select' as const,value:'undeclared',options:['accepted']},
    {fieldType:'multi_select' as const,value:['accepted','undeclared'],options:['accepted']},
    {fieldType:'entity_reference' as const,value:'not-a-uuid',options:['company']},
  ])('Q04 enforces current custom $fieldType values below raw nonowner SQL',async ({fieldType,value,options}) => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey=`validation_${fieldType}`
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional value vocabulary',fieldType,options})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
    const transaction=await client()
    try {
      await expect(transaction.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields}',$2::jsonb) WHERE id=$1",[record.id,{[fieldKey]:value}]))
        .rejects.toMatchObject({code:'22023'})
      await transaction.query('ROLLBACK')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
    } finally {
      await transaction.query('ROLLBACK');transaction.release()
      await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])
    }
  })
  it('Q04 rejects an undeclared custom key below the raw entity writer',async () => {
    const record=await createDeal(userId,{workspaceId,access})
    await expect(updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{undeclared:'value'}}},access)).rejects.toThrow('invalid_value')
    expect((await owner.query("SELECT attributes ? 'custom_fields' AS present FROM entities WHERE id=$1",[record.id])).rows[0].present).toBe(false)
  })
  it('Q04 enforces required custom values on raw create and replacement without partial effects',async () => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey='validation_required'
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional required value',fieldType:'text',isRequired:true})
    try {
      await expect(createEntity({kind:'deal',displayName:'Fictional missing required value',workspaceId,createdByUserId:userId,source:'user',attributes:{stage:'lead'}}))
        .rejects.toThrow('invalid_value')
      expect((await owner.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Fictional missing required value'",[workspaceId])).rows).toEqual([])
      await updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{[fieldKey]:'accepted'}}},access)
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
      await expect(updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{}}},access)).rejects.toThrow('invalid_value')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it('Q04 retains archived custom values while refusing edits and deletion through raw replacements',async () => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey='validation_archived'
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional archived value',fieldType:'text'})
    try {
      await updateCrmCustomFields({ctx:access,entityId:record.id,values:{[fieldKey]:'original'}})
      await archiveCrmFieldDefinition(userId,workspaceId,definition!.id)
      const attributes=(await owner.query('SELECT attributes FROM entities WHERE id=$1',[record.id])).rows[0].attributes
      expect(await updateEntity(userId,record.id,{displayName:'Fictional retained historical value',attributes},access)).toMatchObject({id:record.id})
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
      for(const custom_fields of [{[fieldKey]:'edited'},{}]) {
        await expect(updateEntity(userId,record.id,{attributes:{...attributes,custom_fields}},access)).rejects.toThrow('invalid_value')
        expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
      }
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['organisation_name','position','mailing_address'])
  ('Q04 preserves the compiled native profile text contract for %s below raw writers',async fieldKey => {
    const value=await createContact(userId,{workspaceId,name:'Fictional native profile',access})
    expect(await updateEntity(userId,value.id,{attributes:{custom_fields:{[fieldKey]:'Fictional profile text'}}},access)).toMatchObject({id:value.id})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    for(const invalid of [17,'x'.repeat(fieldKey==='mailing_address'?601:201)]) {
      await expect(updateEntity(userId,value.id,{attributes:{custom_fields:{[fieldKey]:invalid}}},access)).rejects.toThrow('invalid_value')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    }
  })
  it('Q04 refuses an already unsafe native amount number at raw canonical creation',async () => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind:'deal',displayName:'Fictional unsafe amount',workspaceId,createdByUserId:userId,source:'user',attributes:{stage:'lead',amount:9007199254740992}}))
      .rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it('Q04 refuses an already unsafe native amount number before a raw canonical patch commits',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(updateEntity(userId,value.id,{attributes:{stage:'lead',amount:9007199254740992}},access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it('Q04 refuses an already unsafe native amount before raw canonical supersession',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(supersedeEntity(userId,value.id,{attributes:{stage:'lead',amount:9007199254740992}})).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q03/Q04 does not reveal a private native kind while refusing an unsafe amount input',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    await owner.query('UPDATE entities SET user_id=$2 WHERE id=$1',[value.id,userId])
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    expect(await updateEntity(readerId,value.id,{attributes:{stage:'lead',amount:9007199254740992}},{...access,userId:readerId})).toBeNull()
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  function crmHttp() {
    const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as typeof req & {userId:string}).userId=userId;next()})
    app.use('/api/crm',crmRoutes({workspaceStore:createWorkspaceStore()}));return app
  }
  it('Q04/Q05 rolls back a real CRM HTTP create when a later owner field is invalid',async () => {
    const name=`Fictional atomic HTTP create ${randomUUID()}`
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'deal',name,ownerId:'invalid-identifier',amount:'12.25'})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,name])).rows).toEqual([])
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04/Q05 rolls back an earlier typed amount patch when a later CRM HTTP currency field refuses',async () => {
    const deal=await createDeal(userId,{workspaceId,access,amount:'12.25'})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]
    const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${deal.id}`).send({amount:'23.75',currencyCode:'$$$'})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]).toEqual(before)
  })
  it('Q04/Q05 rolls back a real CRM HTTP creation when its activity insert fails',async () => {
    const name=`Fictional atomic HTTP activity ${randomUUID()}`
    await owner.query(`CREATE FUNCTION native_operation_http_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${workspaceId}'::uuid THEN RAISE EXCEPTION 'Fictional activity storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_http_activity_fixture BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION native_operation_http_activity_fixture()`)
    try {
      const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name})
      expect(response.status).toBe(400)
      expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,name])).rows).toEqual([])
      expect((await owner.query('SELECT id FROM crm_activities WHERE workspace_id=$1 AND summary=$2',[workspaceId,'CRM record created'])).rows).toEqual([])
    } finally {await owner.query('DROP TRIGGER native_operation_http_activity_fixture ON crm_activities;DROP FUNCTION native_operation_http_activity_fixture()')}
  })
  it.each(['archive','custom','pipeline'] as const)('Q04/Q05 rolls back the actual CRM %s route and its source version when activity storage fails',async operation => {
    const field=operation==='custom'?await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'http_rollback_custom',label:'Fictional HTTP rollback custom',fieldType:'text'}):null
    const value=operation==='pipeline'?await createDeal(userId,{workspaceId,access,amount:'12.25'}):await createCompany(userId,{workspaceId,name:`Fictional secondary HTTP ${randomUUID()}`,access,mergeByName:false,
      ...(operation==='custom'?{customFields:{http_rollback_custom:'before'}}:{})})
    const config=operation==='pipeline'?await getCrmConfig(userId,workspaceId):null
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await owner.query(`CREATE FUNCTION native_operation_http_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${workspaceId}'::uuid THEN RAISE EXCEPTION 'Fictional activity storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_http_activity_fixture BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION native_operation_http_activity_fixture()`)
    try {
      const app=request(crmHttp()),base=`/api/crm/${workspaceId}/records/${value.id}`
      const response=operation==='archive'?await app.post(`${base}/archive`).send({}):operation==='custom'?await app.patch(`${base}/custom-fields`).send({values:{http_rollback_custom:'after'}})
        :await app.patch(`${base}/pipeline-stage`).send({stageId:config!.pipelines[0].stages.find(stage=>stage.legacyKey==='won')!.id})
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
      expect((await owner.query('SELECT id FROM crm_activities WHERE entity_id=$1',[value.id])).rows).toEqual([])
    } finally {
      await owner.query('DROP TRIGGER native_operation_http_activity_fixture ON crm_activities;DROP FUNCTION native_operation_http_activity_fixture()')
      if(field) await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[field.id])
    }
  })
  it.each(['unknown','invalid-type','overlong'] as const)('Q04 refuses an original CRM HTTP creation frame: %s',async invalid => {
    const body=invalid==='unknown'?{unexpected_key:true}:invalid==='invalid-type'?{domain:{secret:'unaccepted'}}:{name:'x'.repeat(257)}
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name:'Fictional original frame',...body})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04 preserves every admitted CRM HTTP tag and refuses an overlong patch without truncation',async () => {
    const tags=Array.from({length:64},(_,index)=>`fictional-tag-${index}`)
    const created=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name:`Fictional full tags ${randomUUID()}`,tags})
    expect(created.status).toBe(201)
    expect((await owner.query("SELECT attributes->'tags' AS tags FROM entities WHERE id=$1",[created.body.id])).rows[0].tags).toEqual(tags)
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[created.body.id])).rows[0]
    const patched=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${created.body.id}`).send({domain:'x'.repeat(321)})
    expect(patched.status).toBe(400)
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[created.body.id])).rows[0]).toEqual(before)
  })
  it('Q04 rolls back every real CRM mapped-row batch member when a later original frame refuses',async () => {
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/import`).send({records:[{kind:'company',name:`Fictional first batch ${randomUUID()}`},{kind:'company',name:'Fictional refused batch',unknown_field:true}]})
    expect(response.status).toBe(400);expect(response.body.created).toBe(0)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04/Q05 commits a real CRM mapped-row batch once with only committed record IDs',async () => {
    const names=[`Fictional first committed batch ${randomUUID()}`,`Fictional second committed batch ${randomUUID()}`]
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/import`).send({records:names.map(name=>({kind:'company',name}))})
    expect(response.status).toBe(207);expect(response.body).toMatchObject({created:2,failed:0})
    const rows=(await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=ANY($2::text[]) ORDER BY id',[workspaceId,names])).rows
    expect(rows).toHaveLength(2);expect(response.body.results.map((row:{id:string})=>row.id).sort()).toEqual(rows.map(row=>row.id))
  })
  it('Q04/Q05 commits a real CRM HTTP combined custom patch on the existing company ID and one revision',async () => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional HTTP combined ${randomUUID()}`,access,mergeByName:false})
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'http_required',label:'Fictional HTTP requirement',fieldType:'text',isRequired:true})
    try {
      const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${value.id}`).send({domain:'http.example',customFields:{http_required:'accepted'}})
      expect(response.status).toBe(200)
      expect((await owner.query("SELECT id,attributes->>'domain' AS domain,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({id:value.id,domain:'http.example',custom:{http_required:'accepted'},version:String(BigInt(version)+1n)})
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[definition!.id])}
  })
  it('Q05 synchronizes the real CRM HTTP primary participant with one canonical deal edit',async () => {
    const first=await createContact(userId,{workspaceId,name:'Fictional first HTTP participant',access}),second=await createContact(userId,{workspaceId,name:'Fictional second HTTP participant',access})
    const deal=await createDeal(userId,{workspaceId,contactId:first.id,access})
    const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0].version
    const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${deal.id}`).send({contactId:second.id})
    expect(response.status).toBe(200)
    expect((await owner.query("SELECT id,attributes->>'contact_id' AS contact,scope_version::text AS version FROM entities WHERE id=$1",[deal.id])).rows[0])
      .toEqual({id:deal.id,contact:second.id,version:String(BigInt(version)+1n)})
    expect((await owner.query('SELECT contact_id AS contact FROM crm_deal_contacts WHERE deal_id=$1 AND is_primary',[deal.id])).rows).toEqual([{contact:second.id}])
  })
  it.each(['company','person','deal'] as const)('Q04 sends actual legacy view %s initial custom values to the canonical writer',async kind => {
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:'view_required',label:'Fictional view requirement',fieldType:'text',isRequired:true})
    try {
      const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as typeof req & {userId:string}).userId=userId;next()})
      app.use('/api',viewsRoutes({workspaceStore:createWorkspaceStore(),crmStore:createDbCrmStore(),savedViewStore:{},taskStore:{},workflowRunStore:{},workspaceDirectory:{},softDeleteStore:{}} as ViewsRouteOptions))
      const route=kind==='company'?'companies':kind==='person'?'contacts':'deals'
      const body={workspaceId,...(kind==='deal'?{}:{name:`Fictional required view ${randomUUID()}`}),customFields:{view_required:'accepted'}}
      const response=await request(app).post(`/api/${route}`).send(body)
      expect(response.status).toBe(201)
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[response.body.id])).rows[0]).toEqual({custom:{view_required:'accepted'},version:'1'})
      expect((await request(app).post(`/api/${route}`).send({...body,unknown_original_key:true})).status).toBe(400)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[definition!.id])}
  })
  it.each(['company','person','deal'] as const)
  ('Q04/Q05 creates canonical %s required custom values in the initial row',async kind => {
    const key='initial_required',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional required initial value',fieldType:'text',isRequired:true})
    try {
      const customFields={[key]:'accepted'}
      const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional initial ${randomUUID()}`,access,mergeByName:false,customFields} as Parameters<typeof createCompany>[1])
        :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional initial contact',access,customFields} as Parameters<typeof createContact>[1])
        :await createDeal(userId,{workspaceId,amount:'12.000000000000000001',access,customFields} as Parameters<typeof createDeal>[1])
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({custom:customFields,version:'1'})
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)
  ('Q04/Q05 applies canonical %s business and required custom edits in one version',async kind => {
    const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional combined ${randomUUID()}`,access,mergeByName:false})
      :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional combined contact',access}):await createDeal(userId,{workspaceId,amount:12,access})
    const key='combined_required',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional required combined value',fieldType:'text',isRequired:true})
    try {
      const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const customFields={[key]:'accepted'}
      const updated=kind==='company'?await updateCompany(userId,value.id,{domain:'combined.example',customFields} as CompanyUpdateFields,access)
        :kind==='person'?await updateContact(userId,value.id,{phone:'+1 202 555 0101',customFields} as ContactUpdateFields,undefined,access)
        :await updateDeal(userId,value.id,{amount:'12.000000000000000001',customFields} as DealUpdateFields,undefined,access)
      expect(updated).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({custom:customFields,version:String(BigInt(version)+1n)})
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
      const invalid={customFields:{[key]:17}}
      const write=kind==='company'?()=>updateCompany(userId,value.id,invalid as CompanyUpdateFields,access)
        :kind==='person'?()=>updateContact(userId,value.id,invalid as ContactUpdateFields,undefined,access)
        :()=>updateDeal(userId,value.id,invalid as DealUpdateFields,undefined,access)
      await expect(write()).rejects.toMatchObject({code:'invalid_value'})
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)('Q04/Q05 joins initial %s custom-reference privacy and refuses a hidden target without partial creation',async kind => {
    const target=await createEntity({workspaceId,kind:'company',displayName:`Fictional private reference ${randomUUID()}`,userId,createdByUserId:userId,source:'user',attributes:{}})
    const hidden=await createEntity({workspaceId,kind:'company',displayName:`Fictional hidden reference ${randomUUID()}`,userId:readerId,createdByUserId:readerId,source:'user',attributes:{}})
    const key='initial_reference',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional initial reference',fieldType:'entity_reference',options:['company'],isRequired:true})
    const create=(id:string)=>kind==='company'?createCompany(userId,{workspaceId,name:`Fictional scoped custom ${randomUUID()}`,access,mergeByName:false,customFields:{[key]:id}})
      :kind==='person'?createContact(userId,{workspaceId,name:'Fictional scoped custom person',access,customFields:{[key]:id}})
      :createDeal(userId,{workspaceId,access,customFields:{[key]:id}})
    try {
      const value=await create(target.id)
      expect((await owner.query("SELECT user_id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({user_id:userId,custom:{[key]:target.id},version:'1'})
      const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      await expect(create(hidden.id)).rejects.toMatchObject({code:'scope_operation_denied'})
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it('Q04/Q05 keeps one company identity and one revision when upserting newly required custom values',async () => {
    const name=`Fictional required upsert ${randomUUID()}`,value=await createCompany(userId,{workspaceId,name,access})
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'upsert_required',label:'Fictional upsert requirement',fieldType:'text',isRequired:true})
    try {
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      expect(await createCompany(userId,{workspaceId,name,domain:'upsert.example',access,customFields:{upsert_required:'accepted'}})).toMatchObject({id:value.id,domain:'upsert.example'})
      expect((await owner.query("SELECT id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE workspace_id=$1 AND display_name=$2",[workspaceId,name])).rows)
        .toEqual([{id:value.id,custom:{upsert_required:'accepted'},version:String(BigInt(before)+1n)}])
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)('Q04 executes the actual %s tool with required initial custom values and refuses a malformed retry',async kind => {
    const company=kind==='deal'?await createCompany(userId,{workspaceId,name:`Fictional tool relation ${randomUUID()}`,access,mergeByName:false}):null
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:'tool_required',label:'Fictional tool requirement',fieldType:'text',isRequired:true})
    try {
      const tools=createCrmTools(createDbCrmStore()),context=executionToolContext(await execution(),{appId:'Fictional CRM fixture'})
      const tool=kind==='company'?tools.saveCompany:kind==='person'?tools.saveContact:tools.saveDeal
      const input={...(kind==='deal'?{company_id:company!.id}:{name:`Fictional required tool ${randomUUID()}`}),custom_fields:{tool_required:'accepted'}}
      expect((await tool.execute(input,context)).isError).toBeFalsy()
      const rows=(await owner.query("SELECT id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE workspace_id=$1 AND kind=$2 AND attributes->'custom_fields' ? 'tool_required'",[workspaceId,kind])).rows
      expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({custom:{tool_required:'accepted'},version:'1'})
      const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      expect((await tool.execute({...input,unknown_business_key:true},context)).isError).toBe(true)
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['catalog stage','registered stage','primary participant removal'] as const)
  ('Q04/Q05 keeps untouched numeric JSON exact through the legacy %s writer',async operation => {
    const contact=await createContact(userId,{workspaceId,name:'Fictional precision contact',access})
    const deal=await createDeal(userId,{workspaceId,contactId:contact.id,amount:'123.456789012345678',access})
    const exact='9007199254740993.123456789012345678',connection=await client()
    try {await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{precision_guard}',to_jsonb($2::numeric)) WHERE id=$1",[deal.id,exact]);await connection.query('COMMIT')}
    finally {await connection.query('ROLLBACK');connection.release()}
    if(operation==='primary participant removal') {
      await addCrmDealParticipant({ctx:access,dealId:deal.id,contactId:contact.id,isPrimary:true})
      expect(await removeCrmDealParticipant({ctx:access,dealId:deal.id,contactId:contact.id})).toBe(true)
    } else {
      const config=await getCrmConfig(userId,workspaceId),pipeline=config.pipelines[0],stage=pipeline.stages.find(value => value.legacyKey==='won')!
      if(operation==='catalog stage') expect(await setCrmDealPipelineStage({ctx:access,entityId:deal.id,stageId:stage.id})).toMatchObject({entity:{id:deal.id}})
      else {
        const transaction=await client()
        try {
          const service=createCrmOperationsService(createDbCrmOperationsStore(getAppPool(),transaction))
          const context={workspaceId,actor:{kind:'user' as const,userId},authority:{role:'owner' as const,canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
          const command={kind:'set_deal_pipeline_stage' as const,dealId:deal.id,pipelineId:pipeline.id,stageId:stage.id}
          const committed=await service.execute(context,command)
          expect(committed.emittedEventIds).toHaveLength(1)
          expect((await service.execute(context,command)).duplicate).toBe(true)
          expect((await transaction.query('SELECT id FROM crm_domain_event_outbox WHERE workspace_id=$1 AND subject_id=$2',[workspaceId,deal.id])).rows)
            .toEqual([{id:committed.emittedEventIds[0]}])
          await transaction.query('COMMIT')
        } finally {await transaction.query('ROLLBACK');transaction.release()}
      }
    }
    expect((await owner.query("SELECT attributes->>'precision_guard' AS exact,attributes->>'amount' AS amount FROM entities WHERE id=$1",[deal.id])).rows[0])
      .toEqual({exact,amount:'123.456789012345678'})
  })
  it('Q05/Q06 rolls back a real nonowner registered stage when its outbox insert fails',async () => {
    const deal=await createDeal(userId,{workspaceId,amount:'123.000000000000000001',access}),config=await getCrmConfig(userId,workspaceId)
    const pipeline=config.pipelines[0],stage=pipeline.stages.find(value => value.legacyKey==='won')!
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]
    await owner.query(`CREATE FUNCTION native_operation_outbox_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.subject_id='${deal.id}'::uuid THEN RAISE EXCEPTION 'Fictional outbox storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_outbox_fixture BEFORE INSERT ON crm_domain_event_outbox FOR EACH ROW EXECUTE FUNCTION native_operation_outbox_fixture()`)
    const transaction=await client()
    try {
      const service=createCrmOperationsService(createDbCrmOperationsStore(getAppPool(),transaction))
      await expect(service.execute({workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}},
        {kind:'set_deal_pipeline_stage',dealId:deal.id,pipelineId:pipeline.id,stageId:stage.id})).rejects.toThrow('Fictional outbox storage refusal')
      await transaction.query('ROLLBACK')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]).toEqual(before)
      for(const table of ['crm_activities','crm_domain_event_outbox','association_audit_log','workspace_audit_log']) {
        const key=table==='crm_activities'?'entity_id':'subject_id'
        expect((await owner.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND ${key}=$2`,[workspaceId,deal.id])).rows).toEqual([])
      }
    } finally {
      await transaction.query('ROLLBACK');transaction.release()
      await owner.query('DROP TRIGGER native_operation_outbox_fixture ON crm_domain_event_outbox;DROP FUNCTION native_operation_outbox_fixture()')
    }
  })
  it('Q04/Q05 preserves an exact native decimal amount through canonical creation, get and list',async () => {
    const amount='9007199254740993.123456789012345678'
    const value=await createDeal(userId,{workspaceId,amount:amount as unknown as number,access})
    expect(value.amount).toBe(amount)
    const dispatcher=new ApplicationPlatformService([(await import('../native-adapters.js')).createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(await execution(),'native','get',{type:'deal',id:value.id}) as {values:Record<string,unknown>}).values.amount).toBe(amount)
    expect((await getDealById(access,value.id))?.amount).toBe(amount)
    expect((await listDeals(access,{})).find(row => row.id===value.id)?.amount).toBe(amount)
    expect((await owner.query("SELECT attributes->>'amount' AS amount FROM entities WHERE id=$1",[value.id])).rows[0].amount).toBe(amount)
  })
  it('Q04/Q05 preserves original numeric precision on native deal reads and unrelated partial edits',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access}),amount='9007199254740993.123456789012345678'
    const connection=await client()
    try {await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{amount}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,amount]);await connection.query('COMMIT')}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await getDealById(access,value.id))?.amount).toBe(amount)
    expect((await listDeals(access,{})).find(row => row.id===value.id)?.amount).toBe(amount)
    expect(await updateDeal(userId,value.id,{externalRef:{fictional:'preserved'}},undefined,access)).toMatchObject({id:value.id,amount})
    expect((await owner.query("SELECT attributes->>'amount' AS amount FROM entities WHERE id=$1",[value.id])).rows[0].amount).toBe(amount)
  })
  it('Q04/Q05 preserves an exact decimal patch, source identity and version',async () => {
    const before=await createDeal(userId,{workspaceId,amount:12,access}),amount='9007199254740993.000000000000000001'
    const prior=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version
    expect(await updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).toMatchObject({id:before.id,amount})
    expect((await getDealById(access,before.id))?.amount).toBe(amount)
    expect((await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version).toBe(String(BigInt(prior)+1n))
  })
  it.each(['1e8','-1','NaN','01.2','1.1234567890123456789',9007199254740992])('Q04 refuses an invalid or already unsafe native amount: %s',async amount => {
    const before=await createDeal(userId,{workspaceId,amount:12,access})
    await expect(updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await getDealById(access,before.id))?.amount).toBe(12)
  })
  describe('[COMP:security/native-field-policy] canonical native CRM write admission',() => {
    const nativeOrigin={kind:'native',moduleKey:'native'}
    beforeAll(async () => {
      await owner.query(`CREATE SEQUENCE native_operation_field_fixture_seq;
        CREATE TABLE native_operation_field_fixture_epochs(workspace_id uuid PRIMARY KEY,revision bigint NOT NULL);
        CREATE FUNCTION native_operation_field_fixture_revision(w uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT coalesce((SELECT revision::text FROM public.native_operation_field_fixture_epochs WHERE workspace_id=w),'0') $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_revision(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_changed() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE w uuid;BEGIN w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
          INSERT INTO public.native_operation_field_fixture_epochs(workspace_id,revision) VALUES(w,nextval('public.native_operation_field_fixture_seq'))
            ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('public.native_operation_field_fixture_seq');RETURN NULL;END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_changed() FROM PUBLIC;
        CREATE TRIGGER native_operation_field_fixture_configuration AFTER INSERT OR UPDATE OR DELETE ON public.crm_field_definitions
          FOR EACH ROW EXECUTE FUNCTION native_operation_field_fixture_changed();
        CREATE FUNCTION native_operation_field_fixture_rules() RETURNS jsonb
        LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT '[{"key":"name","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["external_user","service"]},
            {"key":"domain","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["external_user","service"]},
            {"key":"archivedAt","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"tags","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"externalRef","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"custom.cost","read":[["finance"]],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"aliases","read":[],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"createdAt","read":[],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"updatedAt","read":[],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]}]'::jsonb $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_rules() FROM PUBLIC;
        CREATE TABLE native_operation_field_fixture_config(workspace_id uuid PRIMARY KEY,rules jsonb,point_requires_finance boolean NOT NULL DEFAULT false);
        CREATE TRIGGER native_operation_field_fixture_policy_configuration AFTER INSERT OR UPDATE OR DELETE ON public.native_operation_field_fixture_config
          FOR EACH ROW EXECUTE FUNCTION native_operation_field_fixture_changed();
        CREATE FUNCTION native_operation_field_fixture_rules_for(w uuid) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT coalesce((SELECT rules FROM public.native_operation_field_fixture_config WHERE workspace_id=w),public.native_operation_field_fixture_rules()) $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_rules_for(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_keys(w uuid) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT to_jsonb(ARRAY['name','domain','tags','externalRef','archivedAt','aliases','createdAt','updatedAt']||ARRAY(SELECT 'custom.'||field_key FROM public.crm_field_definitions
            WHERE workspace_id=w AND entity_kind='company' AND archived_at IS NULL ORDER BY field_key)) $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_keys(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_keys_for(w uuid,t text) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT CASE t WHEN 'company' THEN public.native_operation_field_fixture_keys(w)
            WHEN 'person' THEN '["name","email","phone"]'::jsonb WHEN 'deal' THEN '["name","stage","amount"]'::jsonb END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_keys_for(uuid,text) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_rules_type(w uuid,t text) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT CASE WHEN t='company' THEN public.native_operation_field_fixture_rules_for(w)
            ELSE (SELECT jsonb_agg(jsonb_build_object('key',field,'read','[]'::jsonb,'write','[]'::jsonb,
              'releaseReadTo','["external_user","service"]'::jsonb,'releaseWriteTo','["external_user","service"]'::jsonb) ORDER BY position)
              FROM jsonb_array_elements_text(public.native_operation_field_fixture_keys_for(w,t)) WITH ORDINALITY fields(field,position)) END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_rules_type(uuid,text) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE source jsonb;BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t NOT IN('company','person','deal') THEN RETURN NULL;END IF;
          IF NOT EXISTS(SELECT 1 FROM public.entities WHERE workspace_id=w AND id=i::uuid AND kind=t) THEN RETURN NULL;END IF;
          source:=public.read_scope_source(w,'entity',i::uuid);
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','recordVersion',source->>'version','fieldKeys',public.native_operation_field_fixture_keys_for(w,t),
            'fields',CASE WHEN source->>'userId' IS NOT NULL OR coalesce((SELECT point_requires_finance FROM public.native_operation_field_fixture_config WHERE workspace_id=w),false) THEN jsonb_set(public.native_operation_field_fixture_rules_type(w,t),'{0,write}','[["finance"]]'::jsonb) ELSE public.native_operation_field_fixture_rules_type(w,t) END,'source',source);END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t NOT IN('company','person','deal') THEN RETURN NULL;END IF;
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','fieldKeys',public.native_operation_field_fixture_keys_for(w,t),'fields',public.native_operation_field_fixture_rules_type(w,t),
            'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text) FROM PUBLIC`)
      await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'cost',label:'Fictional cost',fieldType:'number'})
      await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
        VALUES('native','1',ARRAY['finance'],'native_operation_field_fixture_reader(uuid,jsonb,text,text)'::regprocedure,
          'native_operation_field_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'native_operation_field_fixture_revision(uuid)'::regprocedure)`)
      await owner.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) SELECT $1,$2,type,'native' FROM unnest(ARRAY['company','person','deal']) type",[workspaceId,nativeOrigin])
      // The provisioning actor has an explicit current field role; tested
      // ordinary readers never inherit owner status or that assignment.
      await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$2)",[workspaceId,userId])
    })
    afterAll(async () => {
      await owner.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await owner.query('DROP TRIGGER native_operation_field_fixture_configuration ON crm_field_definitions')
      await owner.query('DROP FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_rules_type(uuid,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_keys_for(uuid,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_keys(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_rules_for(uuid)')
      await owner.query('DROP TABLE native_operation_field_fixture_config')
      await owner.query('DROP FUNCTION native_operation_field_fixture_rules()')
      await owner.query('DROP FUNCTION native_operation_field_fixture_revision(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_changed()')
      await owner.query('DROP TABLE native_operation_field_fixture_epochs')
      await owner.query('DROP SEQUENCE native_operation_field_fixture_seq')
    })
    async function company() {
      const value=await createCompany(userId,{workspaceId,name:`Fictional protected company ${randomUUID()}`,access,mergeByName:false})
      await updateCrmCustomFields({ctx:access,entityId:value.id,values:{cost:42}})
      return value
    }
    async function member<T>(actor:string,operation:(client:PoolClient)=>Promise<T>) {
      const connection=await getAppPool().connect()
      try {await connection.query('BEGIN');await applyRLSGucs(connection,actor);const value=await operation(connection);await connection.query('COMMIT');return value}
      finally {await connection.query('ROLLBACK');connection.release()}
    }
    const reader={...access,userId:readerId}
    async function snapshot(id:string) {return (await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[id])).rows[0]}
    async function protectedCreator(kind:'member'|'external_user'|'service',principalId?:string,type:'company'|'person'|'deal'='company',patchTarget?:string|readonly string[],patchFields?:string[],patchCommand='patch_company',readFields:string[]=[]) {
      const appId=randomUUID(),grantId=randomUUID()
      const fields=patchFields??(type==='company'?['name','domain']:type==='person'?['name','email','phone']:['name','stage','amount'])
      const key=patchTarget?patchCommand:type==='company'?'create_company':type==='person'?'create_contact':'create_deal'
      const selector=patchTarget?{kind:'ids' as const,ids:typeof patchTarget==='string'?[patchTarget]:[...patchTarget]}:{kind:'self' as const}
      let actor=principalId??readerId
      if(kind!=='member' && !principalId) {
        actor=randomUUID();fixtureUsers.push(actor)
        await owner.query('INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,$2,$3)',[actor,kind==='service'?'channel':'email',
          kind==='service'?`app-service:${appId}:${randomUUID()}`:`fictional-${randomUUID()}@example.com`])
      }
      await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
        VALUES($1,$2,'native','Fictional protected creator','api_client',$3,$4)`,[appId,workspaceId,assistantId,userId])
      await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
        resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
        VALUES($1,$2,$3,$4,$5,$6,'{"kind":"native","moduleKey":"native"}',$7,$8,$11,$9,
        $10::jsonb,'{}','{}','confidential',now()-interval '1 hour')`,[grantId,appId,workspaceId,kind,actor,userId,type,[patchTarget?'patch':'create',`command:${key}`,...(readFields.length?['read']:[])],fields,selector,readFields])
      const current=(await owner.query('SELECT * FROM application_access_grants WHERE id=$1',[grantId])).rows[0]
      const maximum={version:1,grants:[{id:grantId,appId,workspaceId,principal:{kind,userId:actor},origin:nativeOrigin,typeKey:type,
        actions:current.actions,readFields,writeFields:fields,selector,version:1,status:'active',
        startsAt:current.starts_at.toISOString(),expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'}]}
      if(kind==='service') {
        const secret=await mintApplicationCredentialSecret()
        await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
          VALUES($1,$2,$3,$4,$5,'Fictional protected key','service',$6,$7,now()+interval '1 hour')`,[secret.id,appId,workspaceId,userId,actor,secret.secretHash,grantId])
        await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[secret.id,appId,workspaceId,grantId,maximum])
        const credential=await authenticateApplicationCredential(secret.token,appId,loadApplicationCredentialStateSystem)
        expect(credential).not.toBeNull();return {appId,grantId,actor,authentication:{credential:credential!}}
      }
      const client=await createDbOAuthClientStore().register({clientName:'Fictional protected client',clientUri:'https://portal.example',redirectUris:['https://portal.example/callback'],tokenEndpointAuthMethod:'none'})
      fixtureOAuthClients.push(client.clientId);await owner.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1',[appId,client.clientId])
      const id=randomUUID(),secret=randomBytes(32).toString('base64url')
      await owner.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
        VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '1 hour')`,[id,client.clientId,actor,workspaceId,appId,await hashSecret(secret)])
      await owner.query('INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants) VALUES($1,$2,$3,$4,$5,$6)',[id,appId,workspaceId,actor,grantId,JSON.stringify([maximum])])
      const user=await authenticateApplicationOAuth(`oat_${id}_${secret}`,appId);expect(user).not.toBeNull()
      return {appId,grantId,actor,authentication:{user:user!}}
    }
    it.each(['member','external_user','service'] as const)('Q03/Q05/Q06 patches a protected company with a write-only actual %s release and replays references once',async kind=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator(kind,undefined,'company',value.id,['name'])
      const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const epoch=(await owner.query('SELECT revision::text AS value FROM application_policy_workspace_epochs WHERE workspace_id=$1',[workspaceId])).rows[0].value
      const command={idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:value.id,patch:{name:'Fictional patched canonical company'}}}
      const result=await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',command)
      expect(result.resources).toEqual([{workspaceId,origin:nativeOrigin,typeKey:'company',id:value.id,version:(BigInt(before.version)+1n).toString()}])
      expect(JSON.stringify(result)).not.toContain('Fictional patched canonical company')
      expect(await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',command)).toEqual(result)
      const stored=(await owner.query('SELECT display_name,attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
      expect(stored).toMatchObject({display_name:'Fictional patched canonical company',attributes:{custom_fields:{cost:42}},version:result.resources[0].version})
      const history=(await owner.query("SELECT before_image FROM brain_row_versions WHERE workspace_id=$1 AND primitive='entity' AND row_id=$2 AND before_image->>'scope_version'=$3",[workspaceId,value.id,before.version])).rows
      expect(history).toHaveLength(1);expect(history[0].before_image).toMatchObject({id:value.id,display_name:value.name,attributes:{custom_fields:{cost:42}}})
      expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[result.id])).rows[0].count).toBe(1)
      expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[result.id])).rows[0].count).toBe(1)
      expect((await owner.query('SELECT revision::text AS value FROM application_policy_workspace_epochs WHERE workspace_id=$1',[workspaceId])).rows[0].value).toBe(epoch)
      await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[fixture.grantId])
      await expect((async()=>dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',command))()).rejects.toMatchObject({code:'grant_revoked'})
      expect(await snapshot(value.id)).toEqual({attributes:stored.attributes,version:stored.version})
    })
    it.each(['member','external_user','service'] as const)('Q03/Q04 patches only a released domain without requiring name access for actual %s',async kind=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator(kind,undefined,'company',value.id,['domain'])
      const result=await new ApplicationPlatformService([createCanonicalNativeApplicationModule()]).command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
        idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:value.id,patch:{domain:'revised.example'}}})
      const stored=(await owner.query('SELECT display_name,attributes FROM entities WHERE id=$1',[value.id])).rows[0]
      expect(stored.display_name).toBe(value.name);expect(stored.attributes).toMatchObject({domain:'revised.example',custom_fields:{cost:42}})
      expect(result.resources[0]).toMatchObject({id:value.id,version:(BigInt(before.version)+1n).toString()})
    })
    it.each([null,''] as const)('Q04/Q05 retains canonical legacy domain-clear storage for %s',async domain=>{
      const value=await company();await updateCompany(userId,value.id,{domain:'previous.example'},access)
      const result=await updateCompany(userId,value.id,{domain},access)
      expect(result?.domain).toBe(domain)
      const stored=(await owner.query('SELECT canonical_id,attributes FROM entities WHERE id=$1',[value.id])).rows[0]
      expect(stored.canonical_id).toBe(domain);expect(stored.attributes).not.toHaveProperty('domain');expect(stored.attributes.custom_fields.cost).toBe(42)
    })
    it.each([null,''] as const)('Q04/Q05 deletes only a cleared canonical optional custom value for %s',async cleared=>{
      const value=await company(),before=await snapshot(value.id)
      expect(await updateCompany(userId,value.id,{customFields:{cost:cleared}},access)).toMatchObject({id:value.id})
      const stored=await snapshot(value.id);expect(stored.attributes.custom_fields).not.toHaveProperty('cost')
      expect(stored.version).toBe((BigInt(before.version)+1n).toString())
    })
    it('Q04 refuses the full legacy company DTO before effects under a write-only patch release',async()=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator('service',undefined,'company',value.id,['name']),base=createCanonicalNativeApplicationModule(),key=randomUUID()
      let legacyRejected=false
      const dispatcher=new ApplicationPlatformService([{...base,commands:{...base.commands,patch_company:{...base.commands.patch_company,execute:async(context)=>{
        const actor=context.execution.security.access
        try {await updateCompany(actor.userId,value.id,{name:'Fictional unavailable DTO'},actor,context.transaction)}
        catch(error){legacyRejected=(error as {code?:string}).code==='access_unavailable';throw error}
        throw new Error('Legacy DTO accepted an unavailable read')
      }}}}])
      await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
        idempotencyKey:key,expectedVersion:before.version,input:{id:value.id,patch:{name:'Fictional unavailable DTO'}}})).rejects.toMatchObject({code:'access_unavailable'})
      expect(legacyRejected).toBe(true);expect(await snapshot(value.id)).toEqual(before)
      expect((await owner.query("SELECT id FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[value.id,before.version])).rows).toEqual([])
      expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows).toEqual([])
    })
    it('Q05 versions a same-value semantic company patch and captures its previous observable timestamp once',async()=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator('service',undefined,'company',value.id,['name'])
      const previous=(await owner.query('SELECT updated_at FROM entities WHERE id=$1',[value.id])).rows[0].updated_at
      const result=await new ApplicationPlatformService([createCanonicalNativeApplicationModule()]).command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
        idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:value.id,patch:{name:value.name}}})
      expect(result.resources[0].version).toBe((BigInt(before.version)+1n).toString())
      const history=(await owner.query("SELECT before_image FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[value.id,before.version])).rows
      expect(history).toHaveLength(1);expect(new Date(history[0].before_image.updated_at)).toEqual(previous)
      expect((await owner.query('SELECT display_name,updated_at FROM entities WHERE id=$1',[value.id])).rows[0]).toMatchObject({display_name:value.name,updated_at:expect.any(Date)})
      expect((await owner.query('SELECT updated_at>$2 AS advanced FROM entities WHERE id=$1',[value.id,previous])).rows[0].advanced).toBe(true)
    })
    it('Q03/Q06 rolls back a company patch after the actual member field role contracts following the write',async()=>{
      const value=await company(),before=await snapshot(value.id),role=await creatorRole(readerId)
      await setCreatorPolicy({point:true})
      const fixture=await protectedCreator('member',readerId,'company',value.id,['name']),base=createCanonicalNativeApplicationModule(),key=randomUUID();let wrote=false
      const dispatcher=new ApplicationPlatformService([{...base,commands:{...base.commands,patch_company:{...base.commands.patch_company,execute:async(context,raw)=>{
        const result=await base.commands.patch_company.execute(context,raw);wrote=true
        await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role]);return result
      }}}}])
      try {
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
          idempotencyKey:key,expectedVersion:before.version,input:{id:value.id,patch:{name:'Fictional contracted patch'}}})).rejects.toMatchObject({code:'access_unavailable'})
        expect(wrote).toBe(true);expect(await snapshot(value.id)).toEqual(before)
        expect((await owner.query("SELECT id FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[value.id,before.version])).rows).toEqual([])
        expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows).toEqual([])
      } finally {await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role]);await clearCreatorPolicy()}
    })
    it('Q03 retains the actual member custom-field floor behind an external company patch profile',async()=>{
      const rules=(await owner.query('SELECT native_operation_field_fixture_rules() AS rules')).rows[0].rules
      rules.find((field:{key:string})=>field.key==='custom.cost').releaseWriteTo=['external_user']
      await owner.query('INSERT INTO native_operation_field_fixture_config(workspace_id,rules) VALUES($1,$2)',[workspaceId,JSON.stringify(rules)])
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator('external_user',readerId,'company',value.id,['custom.cost'])
      const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command={idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:value.id,patch:{customFields:{cost:43}}}}
      let role:string|undefined
      try {
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',command)).rejects.toMatchObject({code:'access_unavailable'})
        expect(await snapshot(value.id)).toEqual(before)
        role=await creatorRole(readerId)
        expect((await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',command)).resources[0].version).toBe((BigInt(before.version)+1n).toString())
        expect((await snapshot(value.id)).attributes.custom_fields.cost).toBe(43)
      } finally {if(role)await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role]);await clearCreatorPolicy()}
    })
    it('Q05 races independent canonical company commands with one valid version outcome and one history/audit/outbox set',async()=>{
      const value=await company(),before=await snapshot(value.id),a=await protectedCreator('service',undefined,'company',value.id,['name']),b=await protectedCreator('service',undefined,'company',value.id,['name'])
      const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),keys=[randomUUID(),randomUUID()]
      const results=await Promise.allSettled([a,b].map(async(fixture,index)=>dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
        idempotencyKey:keys[index],expectedVersion:before.version,input:{id:value.id,patch:{name:`Fictional race ${index}`}}})))
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
      expect(results.filter(result=>result.status==='rejected')).toEqual([expect.objectContaining({reason:expect.objectContaining({code:'record_version_conflict'})})])
      expect((await snapshot(value.id)).version).toBe((BigInt(before.version)+1n).toString())
      expect((await owner.query("SELECT count(*)::int AS count FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[value.id,before.version])).rows[0].count).toBe(1)
      const receipts=(await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=ANY($2::text[])',[workspaceId,keys])).rows
      expect(receipts).toHaveLength(1)
      for(const table of ['application_command_audit','application_committed_events'])expect((await owner.query(`SELECT count(*)::int AS count FROM ${table} WHERE receipt_id=$1`,[receipts[0].id])).rows[0].count).toBe(1)
    })
    it('Q06 rolls back a company patch history and business row when its registered command fails after the write',async()=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator('service',undefined,'company',value.id,['name']),base=createCanonicalNativeApplicationModule(),key=randomUUID()
      const dispatcher=new ApplicationPlatformService([{...base,commands:{...base.commands,patch_company:{...base.commands.patch_company,execute:async(context,raw)=>{
        await base.commands.patch_company.execute(context,raw);throw new Error('Fictional command rollback')
      }}}}])
      await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_company',{
        idempotencyKey:key,expectedVersion:before.version,input:{id:value.id,patch:{name:'Fictional rolled-back patch'}}})).rejects.toThrow('Fictional command rollback')
      expect(await snapshot(value.id)).toEqual(before)
      expect((await owner.query("SELECT count(*)::int AS count FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[value.id,before.version])).rows[0].count).toBe(0)
      expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows).toEqual([])
    })
    it('Q06 commits and replays one bounded multi-company command using canonical writers and one reference-only operation',async()=>{
      const rows=await Promise.all([company(),company()]),before=await Promise.all(rows.map(row=>snapshot(row.id)))
      const fixture=await protectedCreator('service',undefined,'company',rows.map(row=>row.id),['name'],'patch_companies'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const command={idempotencyKey:randomUUID(),input:{patches:rows.map((row,index)=>({id:row.id,expectedVersion:before[index].version,patch:{name:`Fictional batch ${index}`}}))}}
      const result=await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_companies',command)
      expect(result.resources.map(ref=>ref.id)).toEqual(rows.map(row=>row.id))
      expect(await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_companies',command)).toEqual(result)
      for(const [index,row]of rows.entries()){
        expect(await snapshot(row.id)).toMatchObject({attributes:{custom_fields:{cost:42}},version:(BigInt(before[index].version)+1n).toString()})
        expect((await owner.query("SELECT count(*)::int AS count FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[row.id,before[index].version])).rows[0].count).toBe(1)
      }
      expect(JSON.stringify(result)).not.toContain('Fictional batch')
      for(const table of ['application_command_audit','application_committed_events'])expect((await owner.query(`SELECT count(*)::int AS count FROM ${table} WHERE receipt_id=$1`,[result.id])).rows[0].count).toBe(1)
    })
    it('Q06 rolls back earlier canonical company changes and history after a later batch version conflict',async()=>{
      const rows=await Promise.all([company(),company()]),before=await Promise.all(rows.map(row=>snapshot(row.id))),key=randomUUID()
      const fixture=await protectedCreator('service',undefined,'company',rows.map(row=>row.id),['name'],'patch_companies'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_companies',{idempotencyKey:key,input:{patches:rows.map((row,index)=>({
        id:row.id,expectedVersion:index===1?'999999999':before[index].version,patch:{name:'Fictional uncommitted batch'}}))}})).rejects.toMatchObject({code:'record_version_conflict'})
      for(const [index,row]of rows.entries()){
        expect(await snapshot(row.id)).toEqual(before[index])
        expect((await owner.query("SELECT count(*)::int AS count FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 AND before_image->>'scope_version'=$2",[row.id,before[index].version])).rows[0].count).toBe(0)
      }
      expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows).toEqual([])
    })
    it('Q04/Q06 refuses duplicate, empty, oversized and scalar-version company batches before effects',async()=>{
      const value=await company(),before=await snapshot(value.id),fixture=await protectedCreator('service',undefined,'company',value.id,['name'],'patch_companies'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const patch={id:value.id,expectedVersion:before.version,patch:{name:'Fictional bounded patch'}}
      for(const patches of [[],[patch,patch],Array.from({length:101},()=>({...patch,id:randomUUID()}))])await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_companies',{
        idempotencyKey:randomUUID(),input:{patches}})).rejects.toMatchObject({code:'invalid_value'})
      await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','patch_companies',{
        idempotencyKey:randomUUID(),expectedVersion:before.version,input:{patches:[patch]}})).rejects.toMatchObject({code:'invalid_value'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q03/Q06 retains an independent company reader after the command issuer contracts',async()=>{
      const value=await company(),before=await snapshot(value.id),a=await protectedCreator('service',undefined,'company',value.id,['name']),b=await protectedCreator('service',undefined,'company',value.id,['name'],'patch_company',['name'])
      const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command={idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:value.id,patch:{name:'Fictional independently readable patch'}}}
      await dispatcher.command(await resolveApplicationExecutionContext(a.authentication),'native','patch_company',command)
      await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[a.grantId])
      expect(await dispatcher.query(await resolveApplicationExecutionContext(b.authentication),'native','get',{type:'company',id:value.id,fields:['name']})).toMatchObject({values:{name:'Fictional independently readable patch'}})
      await expect((async()=>dispatcher.command(await resolveApplicationExecutionContext(a.authentication),'native','patch_company',command))()).rejects.toMatchObject({code:'grant_revoked'})
    })
    it.each((['member','external_user','service'] as const).flatMap(kind=>(['company','person','deal'] as const).map(type=>({kind,type}))))(
      'Q03/Q05 creates and replays a protected canonical $type as the actual $kind',async({kind,type})=>{
      const fixture=await protectedCreator(kind,undefined,type),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const key=type==='company'?'create_company':type==='person'?'create_contact':'create_deal'
      const amount='9007199254740993.000000000000000001'
      const input:Record<string,ApplicationJson>=type==='company'?{name:`Fictional protected company ${randomUUID()}`,domain:'fictional.example'}
        :type==='person'?{name:`Fictional protected contact ${randomUUID()}`,email:'fictional@example.com',phone:'555-0100'}
        :{stage:'qualified',amount}
      const command={idempotencyKey:randomUUID(),input},invocation=await resolveApplicationExecutionContext(fixture.authentication)
      const raced=await Promise.all([0,1].map(async()=>dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native',key,command)))
      await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
      const first=raced[0];expect(raced[1]).toEqual(first)
      expect(first.resources).toHaveLength(1);expect(first.resources[0].version).toBe('1')
      const record=(await owner.query('SELECT created_by_user_id,created_by_assistant_id,attributes FROM entities WHERE id=$1',[first.resources[0].id])).rows[0]
      expect(record).toMatchObject({created_by_user_id:fixture.actor,created_by_assistant_id:assistantId,
        attributes:type==='company'?{domain:'fictional.example'}:type==='person'?{email:'fictional@example.com',phone:'555-0100'}:{stage:'qualified',amount}})
      expect(record.attributes).not.toHaveProperty('tags')
      expect(await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native',key,command)).toEqual(first)
      expect((await owner.query('SELECT resources FROM application_operation_receipts WHERE id=$1',[first.id])).rows[0].resources).toEqual(first.resources)
      expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[first.id])).rows[0].count).toBe(1)
      await expect(dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','get',{type,id:first.resources[0].id,fields:['name']})).rejects.toMatchObject({code:'access_unavailable'})
      await owner.query("UPDATE application_access_grants SET write_fields='{}' WHERE id=$1",[fixture.grantId])
      await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native',key,command)).rejects.toMatchObject({code:'access_unavailable'})
      expect((await owner.query('SELECT id FROM entities WHERE id=$1',[first.resources[0].id])).rows).toEqual([{id:first.resources[0].id}])
      if(kind!=='member') expect((await owner.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,fixture.actor])).rows).toEqual([])
    })
    it('Q02/Q03 applies current protected native member fields before query predicates and refuses a missing revision reader',async()=>{
      const value=await company(),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const name=(await owner.query('SELECT display_name FROM entities WHERE id=$1',[value.id])).rows[0].display_name
      const input={type:'company',query:{fields:['name'],filters:[{field:'name',op:'eq',value:name}]}}
      const read=(identity:Awaited<ReturnType<typeof execution>>,body:unknown)=>dispatcher.query(identity,'native','query',body)
      expect((await read(await execution(),input) as {records:unknown[]}).records).toHaveLength(1)
      const lower=(await resolveExecutionContextSystem({userId:readerId,workspaceId,assistant:(await findAssistantById(assistantId))!,memberMode:'member',
        identity:{kind:'attended',principal:{kind:'workspace_member',userId:readerId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
        lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelId:'native-query-fixture',channelType:'test',abortSignal:new AbortController().signal}})).executionContext
      await expect(read(lower,{type:'company',query:{fields:['name'],filters:[{field:'custom.cost',op:'gt',value:100}]}})).rejects.toMatchObject({code:'access_unavailable'})
      const original=(await owner.query("SELECT configuration_reader::text AS reader FROM application_native_field_contracts WHERE module_key='native'")).rows[0].reader
      await owner.query("UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='native'")
      try{await expect(execution()).rejects.toMatchObject({name:'AuthorityChangedError'})}
      finally{await owner.query("UPDATE application_native_field_contracts SET configuration_reader=$1::regprocedure WHERE module_key='native'",[original])}
    })
    async function setCreatorPolicy(options:{finance?:boolean;point?:boolean}) {
      const rules=(await owner.query('SELECT native_operation_field_fixture_rules() AS rules')).rows[0].rules
      if(options.finance) rules[0].write=[['finance']]
      await owner.query(`INSERT INTO native_operation_field_fixture_config(workspace_id,rules,point_requires_finance) VALUES($1,$2,$3)
        ON CONFLICT(workspace_id) DO UPDATE SET rules=excluded.rules,point_requires_finance=excluded.point_requires_finance`,
        [workspaceId,JSON.stringify(rules),options.point??false])
    }
    async function clearCreatorPolicy() {await owner.query('DELETE FROM native_operation_field_fixture_config WHERE workspace_id=$1',[workspaceId])}
    async function creatorRole(actor:string) {
      return (await owner.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
        VALUES($1,'native',$2,'finance',$3) RETURNING id`,[workspaceId,actor,userId])).rows[0].id as string
    }
    const creatorCommand=()=>({idempotencyKey:randomUUID(),input:{name:`Fictional bounded native creation ${randomUUID()}`}})
    async function absentCreator(command:ReturnType<typeof creatorCommand>) {
      expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,command.input.name])).rows).toEqual([])
      expect((await owner.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1',[command.idempotencyKey])).rows).toEqual([])
    }
    it('Q03/Q05 refuses a protected application create at a stricter actual native point',async()=>{
      const fixture=await protectedCreator('member'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command=creatorCommand()
      await setCreatorPolicy({point:true})
      try {
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).rejects.toMatchObject({code:'access_unavailable'})
        await absentCreator(command)
      } finally {await clearCreatorPolicy()}
    })
    it('Q03/Q05 admits a stricter actual native point only with the current member role and stops revoked replay',async()=>{
      const fixture=await protectedCreator('member'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command=creatorCommand()
      await setCreatorPolicy({point:true});const role=await creatorRole(readerId)
      try {
        const receipt=await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)
        expect(receipt.resources[0].version).toBe('1')
        await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).rejects.toMatchObject({code:'access_unavailable'})
        expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,command.input.name])).rows.map(row=>row.id)).toEqual([receipt.resources[0].id])
      } finally {await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role]);await clearCreatorPolicy()}
    })
    it('Q03/Q06 rolls back protected creation when the current issuer role contracts after the canonical insert',async()=>{
      await setCreatorPolicy({finance:true})
      const fixture=await protectedCreator('service'),command=creatorCommand(),base=createCanonicalNativeApplicationModule();let inserted=false
      const role=(await owner.query("SELECT id FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native' AND user_id=$2 AND role_key='finance' AND status='active'",[workspaceId,userId])).rows[0].id
      const dispatcher=new ApplicationPlatformService([{...base,commands:{...base.commands,create_company:{...base.commands.create_company,
        execute:async(context,raw)=>{const result=await base.commands.create_company.execute(context,raw);inserted=true;
          await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role]);return result}}}}])
      try {
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).rejects.toMatchObject({code:'access_unavailable'})
        expect(inserted).toBe(true);await absentCreator(command)
      } finally {await creatorRole(userId);await clearCreatorPolicy()}
    })
    it('Q03 retains the native member role floor behind a protected external profile',async()=>{
      await setCreatorPolicy({finance:true})
      const fixture=await protectedCreator('external_user',readerId),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command=creatorCommand()
      let role:string|undefined
      try {
        await expect(dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).rejects.toMatchObject({code:'access_unavailable'})
        await absentCreator(command)
        role=await creatorRole(readerId)
        expect((await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).resources).toHaveLength(1)
      } finally {if(role) await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role]);await clearCreatorPolicy()}
    })
    it('Q07 holds protected creators on unverified configuration and invalidates an invocation across restore',async()=>{
      const fixture=await protectedCreator('service'),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command=creatorCommand()
      const previous=await resolveApplicationExecutionContext(fixture.authentication)
      await owner.query("UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='native'")
      try {
        await expect(resolveApplicationExecutionContext(fixture.authentication)).rejects.toThrow('Access changed')
        await expect(dispatcher.command(previous,'native','create_company',command)).rejects.toThrow('Access changed')
        await absentCreator(command)
      } finally {await owner.query("UPDATE application_native_field_contracts SET configuration_reader='native_operation_field_fixture_revision(uuid)'::regprocedure WHERE module_key='native'")}
      await expect(previous.security.authority.assertCurrent()).rejects.toThrow('Access changed')
      expect((await dispatcher.command(await resolveApplicationExecutionContext(fixture.authentication),'native','create_company',command)).resources).toHaveLength(1)
    })
    it('Q04/Q05 refuses creation when the actual private native point is stricter than its catalog',async () => {
      const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      await expect(createEntity({kind:'company',displayName:'Fictional private point',workspaceId,createdByUserId:readerId,userId:readerId,source:'user',attributes:{}}))
        .rejects.toThrow('access_unavailable')
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
    })
    it('Q04/Q05 retains a positively admitted actual private native creation point',async () => {
      const value=await createEntity({kind:'company',displayName:'Fictional admitted private point',workspaceId,createdByUserId:userId,userId,source:'user',attributes:{}})
      expect((await owner.query('SELECT id,user_id,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0])
        .toEqual({id:value.id,user_id:userId,version:'1'})
    })
    it('Q04 refuses an unowned-to-native kind promotion when its destination point denies a field',async () => {
      const value=await createEntity({kind:'project',displayName:'Fictional private promotion',workspaceId,createdByUserId:readerId,userId:readerId,source:'user',attributes:{}})
      const before=(await owner.query('SELECT kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
      await expect(member(readerId,connection=>connection.query("UPDATE entities SET kind='company' WHERE id=$1",[value.id]))).rejects.toThrow('access_unavailable')
      expect((await owner.query('SELECT kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    })
    it('Q04/Q05 preserves the canonical ID for a positively admitted native kind promotion',async () => {
      const value=await createEntity({kind:'project',displayName:'Fictional shared promotion',workspaceId,createdByUserId:readerId,source:'user',attributes:{}})
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      await member(readerId,connection=>connection.query("UPDATE entities SET kind='company' WHERE id=$1",[value.id]))
      expect((await owner.query('SELECT id,kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0])
        .toEqual({id:value.id,kind:'company',version:String(BigInt(before)+1n)})
    })
    it('Q04/Q05 archives and restores a protected native company without touching a hidden exact value',async () => {
      const value=await company(),cost='9007199254740993.123456789012345678',reader={...access,userId:readerId}
      await member(userId,connection => connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,cost]))
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const invocation=await execution()
      expect(await setCrmArchived({ctx:reader,entityId:value.id,archived:true})).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes ? 'crm_archived_at' AS archived,attributes->'custom_fields'->>'cost' AS cost FROM entities WHERE id=$1",[value.id])).rows[0]).toEqual({archived:true,cost})
      expect(await setCrmArchived({ctx:reader,entityId:value.id,archived:false})).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes ? 'crm_archived_at' AS archived,attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]).toEqual({archived:false,cost,version:String(BigInt(before)+2n)})
      await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
    })
    it.each([43,42])('Q04 refuses a protected native custom write of %s, including an equal hidden value',async cost => {
      const value=await company(),before=await snapshot(value.id)
      const mask=await member(readerId,async connection => (await connection.query('SELECT read_native_application_field_mask($1,$2,$3,$4,$5) AS value',
        [workspaceId,nativeOrigin,'company',value.id,before.version])).rows[0].value)
      expect(mask.writeFields).not.toContain('custom.cost')
      await expect(updateCrmCustomFields({ctx:reader,entityId:value.id,values:{cost}})).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses protected native fields through the canonical raw entity writer',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(updateEntity(readerId,value.id,{attributes:{...before.attributes,custom_fields:{cost:43}}},reader)).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 keeps actual nonowner raw SQL behind the same protected native field boundary',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses a raw equal attribute replacement without typed partial intent',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it.each(['aliases=aliases',"aliases=ARRAY['Fictional alias']"])('Q04 refuses undeclared canonical alias fields through raw SQL: %s',async assignment => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query(`UPDATE entities SET ${assignment} WHERE id=$1`,[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 does not let a spoofed allowed partial intent hide an actual hidden-field change',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:value.id,fields:['domain']})])
        return (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 scopes partial intent to its exact native record, including equal assignments',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:randomUUID(),fields:['domain']})])
        return (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04/Q05 preserves an untouched hidden JSON numeric field exactly during an allowed native partial edit',async () => {
      const value=await company(),cost='9007199254740993.123456789012345678'
      await member(userId,connection => connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,cost]))
      const before=(await owner.query("SELECT attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]
      expect(await updateCompany(readerId,value.id,{domain:'precise-partial.example'},reader)).toMatchObject({id:value.id,domain:'precise-partial.example'})
      const after=(await owner.query("SELECT attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]
      expect(before.cost).toBe(cost);expect(after.cost).toBe(cost);expect(after.version).toBe(String(BigInt(before.version)+1n))
    })
    it('Q04/Q05 lets a typed allowed native domain edit preserve an unreadable custom field and source identity',async () => {
      const value=await company(),before=await snapshot(value.id)
      expect(await updateCompany(readerId,value.id,{domain:'native-fields.example'},reader)).toMatchObject({id:value.id,domain:'native-fields.example'})
      const after=await snapshot(value.id)
      expect(after.attributes.custom_fields).toEqual({cost:42})
      expect(after.version).toBe(String(BigInt(before.version)+1n))
    })
  })

})
