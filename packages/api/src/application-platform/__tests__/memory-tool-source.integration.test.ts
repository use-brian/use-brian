import {createHash} from 'node:crypto'
/** Actual core memory tools over canonical nonowner writers and source readers. */
import {afterAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,boundScopeSources,createMemoryTools,createRetrievalTools,executionToolContext,type RetrievalStore,type ScopeSource,type ToolContext} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {createDbRowHistoryStore} from '../../db/row-history-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createDbEntityLinksStore} from '../../db/entity-links-store.js'
import type {EntityLinksStore} from '@use-brian/core'
import {createMemory,updateMemory,getMemoryHistory} from '../../db/memories.js'
import {bindSessionContextRetainedAuthority,readRetainedContextFrame,writeRetainedContextFrame} from '../../db/session-context-revisions.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
import {originalMemoryAuthority,saveOriginalMemory,readOriginalMemory} from './fixtures/retained-memory.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] original-authority memory tools',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 const store=createDbMemoryStore(),tools=createMemoryTools(store),historyStore=createDbRowHistoryStore(),historyTools=createRetrievalTools(historyStore as RetrievalStore)
 const authority=originalMemoryAuthority,save=saveOriginalMemory,read=readOriginalMemory

 it('creates actual retained Memory relationship links and hides them from unframed graph readers after source withdrawal',async()=>{
  const x=await sourceModeFixture('internal'),links=createDbEntityLinksStore(),linkedTools=createMemoryTools(store,{entityLinksStore:links})
  try{
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const target=await x.f.memory('Fictional native relationship endpoint'),current=await authority(x),access=current.execution.security.access
   const ordinary=await links.create({sourceKind:'memory',sourceId:target.id,targetKind:'memory',targetId:target.id,edgeType:'mentioned',source:'model',workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId})
   expect((await links.getById(access,ordinary.id))?.id).toBe(ordinary.id)
   expect(await links.closeAt(x.f.ownerId,ordinary.id,new Date())).toMatchObject({id:ordinary.id})
   const observed=await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   const saved=await linkedTools.saveMemory.execute({summary:'Fictional retained relationship result',scope:'team',links:[{targetKind:'memory',targetEntityId:target.id,edgeType:'replies_to'}]},current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true);expect(String(saved.data)).toContain('1 edge linked')
   const memoryId=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(memoryId).toBeTruthy()
   const edge=(await x.f.pool.query("SELECT id,scope_version::text AS version FROM entity_links WHERE workspace_id=$1 AND source_id=$2",[x.f.workspaceId,memoryId])).rows[0];expect(edge).toBeTruthy()
   const lineage=(await x.f.pool.query("SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='entity_link' AND d.resource_id=$2 ORDER BY s.source_kind,s.source_id",[x.f.workspaceId,edge.id])).rows
   expect(lineage).toEqual(expect.arrayContaining([
    expect.objectContaining({source_kind:'memory',source_id:memoryId}),expect.objectContaining({source_kind:'memory',source_id:target.id}),
    ...observed.sources.map(source=>expect.objectContaining({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})),
   ]));expect(lineage.some(row=>row.source_kind==='application_field')).toBe(true)
   expect(current.accumulator.evidence.sources?.some(source=>source.resourceKind==='entity_link'&&source.resourceId===edge.id)).toBe(true)
   const reader=await authority(x),result=await links.getRetainedMemoryLink!(reader.execution.security.access,edge.id,reader)
   expect(result).toMatchObject({id:edge.id,sourceId:memoryId,targetId:target.id});expect(boundScopeSources(result!).some(source=>source.resourceKind==='external_source')).toBe(true)
   reader.accumulator.note({sources:boundScopeSources(result!)});await expect(assertSourceModelInputAuthority(reader.context)).resolves.toBeUndefined()
   expect(await links.getById(access,edge.id)).toBeNull()
   expect((await links.walkOutbound(access,'memory',memoryId!)).map(link=>link.id)).not.toContain(edge.id)
   const previousSessions=new Set((await authSessionStore.listForUser(x.f.ownerId)).map(session=>session.id))
   const committing=await authority(x),committingAuth=(await authSessionStore.listForUser(x.f.ownerId)).find(session=>!previousSessions.has(session.id));expect(committingAuth).toBeTruthy()
   await committing.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   let revoked=0;const queries=new Map<PoolClient,PoolClient['query']>(),written=new WeakSet<PoolClient>()
   const trace=(client:PoolClient)=>{
    if(queries.has(client))return
    const original=client.query;queries.set(client,original)
    client.query=function(...args:unknown[]){
     const sql=typeof args[0]==='string'?args[0]:''
     if(sql.includes('SELECT record_admitted_memory_link_derivation'))written.add(client)
     const result=Reflect.apply(original,client,args)
     if(sql==='COMMIT'&&written.has(client)){written.delete(client);return Promise.resolve(result).then(async value=>{revoked++;expect(await authSessionStore.revokeForUser(x.f.ownerId,committingAuth!.id)).toBe(true);return value})}
     return result
    } as typeof client.query
   }
   getAppPool().on('acquire',trace)
   let uncertain
   try{uncertain=await linkedTools.saveMemory.execute({summary:'Fictional committed uncertain relationship',links:[{targetKind:'memory',targetEntityId:target.id,edgeType:'replies_to'}]},committing.context)}
   finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
   expect(revoked).toBe(1);expect(uncertain.isError,JSON.stringify(uncertain)).not.toBe(true)
   expect(String(uncertain.data)).toContain('relationship updates may have completed');expect(String(uncertain.data)).toContain('Do not repeat the Memory save');expect(String(uncertain.data)).not.toContain('failed')
   const uncertainMemoryId=String(uncertain.data).match(/\[([a-f0-9-]{36})\]/)?.[1]
   expect((await x.f.pool.query('SELECT id FROM entity_links WHERE workspace_id=$1 AND source_id=$2',[x.f.workspaceId,uncertainMemoryId])).rows).toHaveLength(1)
   const freshReader=await authority(x),freshLink=await links.getRetainedMemoryLink!(freshReader.execution.security.access,edge.id,freshReader)
   expect(freshLink?.id).toBe(edge.id);freshReader.accumulator.note({sources:boundScopeSources(freshLink!)})
   await expect(assertSourceModelInputAuthority(freshReader.context)).resolves.toBeUndefined()
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const after=await authority(x)
   await expect(assertSourceModelInputAuthority(freshReader.context)).rejects.toMatchObject({reason:'authority_changed'})
   expect(await links.getRetainedMemoryLink!(after.execution.security.access,edge.id,after).catch(error=>{expect(['scope_source_changed','source_access_denied']).toContain(error.code);return null})).toBeNull()
   await expect(links.createRetainedMemoryLink!({sourceKind:'memory',sourceId:memoryId!,targetKind:'memory',targetId:target.id,edgeType:'mentioned',source:'model',workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId},after)).rejects.toMatchObject({code:'scope_source_changed'})
   expect((await x.f.pool.query("SELECT id FROM entity_links WHERE workspace_id=$1 AND source_id=$2",[x.f.workspaceId,memoryId])).rows).toEqual([{id:edge.id}])
   expect((await x.f.pool.query("SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='entity_link' AND d.resource_id=$2 ORDER BY s.source_kind,s.source_id",[x.f.workspaceId,edge.id])).rows).toEqual(lineage)
   expect((await links.getById(after.execution.security.access,ordinary.id))?.id).toBe(ordinary.id)
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('requires current complete Memory endpoint fields for retained relationship creation and point read',async()=>{
  const x=await sourceModeFixture('internal'),links=createDbEntityLinksStore();let registered=false
  try{
   const target=await x.f.memory('Fictional field restricted relationship endpoint')
   await x.f.pool.query(`CREATE FUNCTION memory_link_field_catalog(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
     'fieldKeys',application_memory_field_keys(),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='detail' THEN '[["reader"]]'::jsonb ELSE '[]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key),
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
    CREATE FUNCTION memory_link_field_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT (memory_link_field_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id))
     FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
    REVOKE ALL ON FUNCTION memory_link_field_catalog(uuid,jsonb,text),memory_link_field_reader(uuid,jsonb,text,text) FROM PUBLIC;
    INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
     VALUES('native','1',ARRAY['reader'],'memory_link_field_reader(uuid,jsonb,text,text)'::regprocedure,'memory_link_field_catalog(uuid,jsonb,text)'::regprocedure)`)
   registered=true
   await x.f.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[x.f.workspaceId])
   await x.f.pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'reader',$2)`,[x.f.workspaceId,x.f.ownerId])
   const current=await authority(x),row=await store.getById(current.execution.security.access,target.id,current)
   expect(row).not.toBeNull();current.accumulator.note({sources:boundScopeSources(row!)})
   const linkedTools=createMemoryTools(store,{entityLinksStore:links}),saved=await linkedTools.saveMemory.execute({summary:'Fictional field retained relationship',links:[{targetKind:'memory',targetEntityId:target.id,edgeType:'replies_to'}]},current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true);expect(String(saved.data)).toContain('1 edge linked')
   const memoryId=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1],edge=(await x.f.pool.query('SELECT id FROM entity_links WHERE workspace_id=$1 AND source_id=$2',[x.f.workspaceId,memoryId])).rows[0]
   const reader=await authority(x);expect((await links.getRetainedMemoryLink!(reader.execution.security.access,edge.id,reader))?.id).toBe(edge.id)
   await x.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   const after=await authority(x)
   expect(await links.getRetainedMemoryLink!(after.execution.security.access,edge.id,after).catch(error=>{expect(['scope_source_changed','source_access_denied']).toContain(error.code);return null})).toBeNull()
   await expect(links.createRetainedMemoryLink!({sourceKind:'memory',sourceId:memoryId!,targetKind:'memory',targetId:target.id,edgeType:'mentioned',source:'model',workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId},after)).rejects.toMatchObject({code:'scope_source_changed'})
   expect(await links.getById(after.execution.security.access,edge.id)).toBeNull()
   expect((await x.f.pool.query('SELECT id FROM entity_links WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([{id:edge.id}])
  }finally{
   await x.f.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   await x.f.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   if(registered)await x.f.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await x.f.pool.query('DROP FUNCTION IF EXISTS memory_link_field_reader(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS memory_link_field_catalog(uuid,jsonb,text)')
   await x.cleanup()
  }
 })
 it('refuses a legacy relationship adapter and changed actor without replaying the successful Memory save',async()=>{
  const x=await sourceModeFixture('internal');let legacyCalls=0
  try{
   const target=await x.f.memory('Fictional legacy adapter endpoint'),current=await authority(x)
   await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   const legacy={create:async()=>{legacyCalls++;throw new Error('Legacy callback must not run')}} as unknown as EntityLinksStore
   const saved=await createMemoryTools(store,{entityLinksStore:legacy}).saveMemory.execute({summary:'Fictional saved with held relationship',links:[{targetKind:'memory',targetEntityId:target.id,edgeType:'replies_to'}]},current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true);expect(String(saved.data)).toContain('1 failed');expect(legacyCalls).toBe(0)
   const memoryId=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(memoryId).toBeTruthy()
   const links=createDbEntityLinksStore(),other=await authority(x,x.f.secondId)
   await expect(links.createRetainedMemoryLink!({sourceKind:'memory',sourceId:memoryId!,targetKind:'memory',targetId:target.id,edgeType:'mentioned',source:'model',workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId},other)).rejects.toMatchObject({code:'scope_evidence_missing'})
   expect((await x.f.pool.query('SELECT id FROM entity_links WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([])
   expect((await x.f.pool.query('SELECT summary FROM memories WHERE id=$1',[memoryId])).rows).toEqual([{summary:'Fictional saved with held relationship'}])
  }finally{await x.cleanup()}
 })
 it('creates through private saveMemory with complete mixed ancestry and preserves both native audience and current source authority',async()=>{
  expect((await getAppPool().query("SELECT has_table_privilege(current_user,'public.application_field_observations','SELECT') AS read,has_table_privilege(current_user,'public.application_field_observations','INSERT') AS insert")).rows).toEqual([{read:false,insert:false}])
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x),before=(await x.f.pool.query("SELECT source_kind,source_id,source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2 ORDER BY source_kind,source_id",[x.f.workspaceId,saved.id])).rows
   expect(before).toEqual(expect.arrayContaining([
    expect.objectContaining({source_kind:'external_source',source_id:saved.read.sources[0].resourceId,source_version:saved.read.sources[0].version}),
    expect.objectContaining({source_kind:'memory',source_id:saved.nativeSource.resourceId,source_version:saved.nativeSource.version}),
    ...saved.fieldRoots.filter(source=>source.resourceKind==='application_field').map(source=>expect.objectContaining({source_kind:'application_field',source_id:source.resourceId,source_version:source.version})),
   ]));expect(before.some(row=>row.source_kind==='application_field')).toBe(true)
   expect((await read(x,saved.id)).data).toMatchObject({id:saved.id,summary:'Fictional source-backed memory tool result'})
   expect((await read(x,saved.id,x.f.secondId)).isError).toBe(true)
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const denied=await read(x,saved.id);expect(denied.isError).toBe(true);expect(JSON.stringify(denied)).not.toContain('Fictional source-backed memory tool result')
   expect((await read(x,saved.id,x.f.secondId)).isError).toBe(true)
   expect((await x.f.pool.query("SELECT source_kind,source_id,source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2 ORDER BY source_kind,source_id",[x.f.workspaceId,saved.id])).rows).toEqual(before)
  }finally{await x.cleanup()}
 })
 it('persists an explicit released observation through the same real tools and refuses another audience or revoked release',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x,'released_snapshot')
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   expect((await read(x,saved.id)).data).toMatchObject({id:saved.id,summary:'Fictional source-backed memory tool result'})
   const releasedReader=await authority(x)
   expect((await store.search(releasedReader.execution.security.access,{query:'source-backed'},releasedReader)).map(row=>row.id)).toContain(saved.id)
   expect((await read(x,saved.id,x.f.secondId)).isError).toBe(true)
   await x.sourcePool.query('UPDATE releases SET expires_at=$2 WHERE id=$1',[x.releaseId,Date.now()-1])
   expect((await read(x,saved.id)).isError).toBe(true)
   await x.sourcePool.query('UPDATE releases SET expires_at=$2 WHERE id=$1',[x.releaseId,x.expiresAt])
   expect((await read(x,saved.id)).data).toMatchObject({id:saved.id})
   await x.sourcePool.query('UPDATE releases SET revoked=true WHERE id=$1',[x.releaseId])
   expect((await read(x,saved.id)).isError).toBe(true)
   expect((await x.f.pool.query('SELECT summary FROM memories WHERE workspace_id=$1 AND id=$2',[x.f.workspaceId,saved.id])).rows).toEqual([{summary:'Fictional source-backed memory tool result'}])
  }finally{await x.cleanup()}
 })
 it('refuses actual saveMemory after source contraction without storing an uncertain or partial derivative',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const current=await authority(x);await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const failure=await tools.saveMemory.execute({summary:'Fictional denied memory sentinel',scope:'team'},current.context).catch(()=>({isError:true}))
   expect(failure.isError).toBe(true)
   expect((await x.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2',[x.f.workspaceId,'Fictional denied memory sentinel'])).rows).toEqual([])
  }finally{await x.cleanup()}
 })
 it('refuses confidential personal output in an original shared audience without weakening output admission',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const current=await authority(x,x.f.ownerId,true);await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   const failure=await tools.saveMemory.execute({summary:'Fictional shared personal output sentinel',scope:'team'},current.context).catch(()=>({isError:true}))
   expect(failure.isError).toBe(true)
   expect((await x.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2',[x.f.workspaceId,'Fictional shared personal output sentinel'])).rows).toEqual([])
  }finally{await x.cleanup()}
 })
 it('SQL independently refuses a native carrier that omits its external or field ancestor edges',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x),root=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,saved.id])).rows[0].source as ScopeSource
   const current=await authority(x),host={execution:current.execution,accumulator:new ContextScopeAccumulator({sources:[root]})}
   bindSessionContextRetainedAuthority(host.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
   await expect(writeRetainedContextFrame(host,[root],async client=>{
    const output=await createMemory({workspaceId:x.f.workspaceId,assistantId:x.f.assistantId,userId:x.f.ownerId,
     createdByUserId:x.f.ownerId,summary:'Fictional omitted ancestry sentinel',sensitivity:root.sensitivity,compartments:[...root.compartments],projectIds:[...root.projectIds]},undefined,client)
    await client.query('SELECT record_admitted_application_field_derivation($1,$2,$3,$4,$5,$6)',
     [x.f.workspaceId,'memory',output.id,output.scopeVersion,'fixture:omitted-ancestry',JSON.stringify([root])])
   })).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
   expect((await x.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2',[x.f.workspaceId,'Fictional omitted ancestry sentinel'])).rows).toEqual([])
  }finally{await x.cleanup()}
 })
 it('commits a genuine source-only native successor through the canonical private clone',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const prior=await x.f.memory('Fictional source-only native predecessor'),current=await authority(x),access=current.execution.security.access
   const source=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,prior.id])).rows[0].source as ScopeSource
   current.accumulator.note({sources:[source]})
   const fingerprint=createHash('sha256').update(JSON.stringify({identity:current.execution.identity,ceiling:current.execution.security.ceiling,ownership:current.execution.ownership})).digest('hex')
   const next=await writeRetainedContextFrame(current,[source],client=>updateMemory(prior.id,
    {detail:'Fictional source-only successor detail',derivation:{producer:'fixture:source-only-successor',sources:[source]}},access,client,
    {expectedVersion:source.version,writeFields:['detail'],assistantId:current.execution.assistant.id,sessionId:current.execution.lifecycle.sessionId,contextFingerprint:fingerprint}))
   expect(next).toMatchObject({summary:prior.summary,detail:'Fictional source-only successor detail',createdByUserId:prior.createdByUserId,createdByAssistantId:prior.createdByAssistantId})
   expect(next!.id).not.toBe(prior.id)
   expect((await x.f.pool.query('SELECT valid_to IS NOT NULL AS retired,superseded_by,scope_version::text AS version FROM memories WHERE id=$1',[prior.id])).rows).toEqual([{retired:true,superseded_by:next!.id,version:source.version}])
   const edges=(await x.f.pool.query("SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2 ORDER BY s.source_kind,s.source_id",[x.f.workspaceId,next!.id])).rows
   expect(edges).toEqual([{source_kind:'memory',source_id:prior.id,source_version:source.version}])
   expect((await x.f.pool.query('SELECT predecessor_id,successor_id,actor_id,assistant_id,session_id,write_fields FROM native_memory_successor_transitions WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([{predecessor_id:prior.id,successor_id:next!.id,actor_id:x.f.ownerId,assistant_id:x.f.assistantId,session_id:current.execution.lifecycle.sessionId,write_fields:['detail']}])
  }finally{await x.cleanup()}
 })
 it('updates through the actual tool while preserving immutable predecessor, original query domain and guarded history',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x,'governed',false),current=await authority(x),access=current.execution.security.access
   const before=(await x.f.pool.query('SELECT summary,detail,scope_version,created_by_user_id,created_by_assistant_id FROM memories WHERE id=$1',[saved.id])).rows[0]
   const matches=await store.search(access,{query:'source-backed'},current),querySources=boundScopeSources(matches)
   expect(matches.map(row=>row.id)).toEqual([saved.id]);current.accumulator.note({sources:querySources})
   const result=await tools.saveMemory.execute({id:saved.id,detail:'Fictional successor refinement'},current.context)
   expect(result.isError,JSON.stringify(result)).not.toBe(true)
   const nextId=String(result.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(nextId).toBeTruthy();expect(nextId).not.toBe(saved.id)
   const predecessor=(await x.f.pool.query('SELECT summary,detail,scope_version,created_by_user_id,created_by_assistant_id,valid_to,superseded_by,scope_held FROM memories WHERE id=$1',[saved.id])).rows[0]
   expect(predecessor).toMatchObject({...before,superseded_by:nextId,scope_held:false});expect(predecessor.valid_to).not.toBeNull()
   expect((await read(x,nextId!)).data).toMatchObject({id:nextId,summary:before.summary,detail:'Fictional successor refinement'})
   expect((await read(x,saved.id)).isError).toBe(true)
   await expect(readRetainedContextFrame(current,querySources,async()=>true)).resolves.toBe(true)
   const reader=await authority(x),fresh=await store.search(reader.execution.security.access,{query:'source-backed'},reader)
   expect(fresh.map(row=>row.id)).toEqual([nextId])
   const history=await getMemoryHistory(nextId!,reader.execution.security.access,reader)
   expect(history.currentId).toBe(nextId);expect(history.chain.map(row=>row.id)).toEqual([saved.id,nextId])
   expect(history.chain[0]).toMatchObject({detail:before.detail,summary:before.summary,supersededBy:nextId})
   expect(history.chain[1]).toMatchObject({detail:'Fictional successor refinement',createdByUserId:before.created_by_user_id,createdByAssistantId:before.created_by_assistant_id})
   const transition=(await x.f.pool.query('SELECT actor_id,assistant_id,session_id,write_fields FROM native_memory_successor_transitions WHERE predecessor_id=$1',[saved.id])).rows[0]
   expect(transition).toEqual({actor_id:x.f.ownerId,assistant_id:x.f.assistantId,session_id:current.execution.lifecycle.sessionId,write_fields:['detail']})
   await x.f.memory('Fictional unrelated newly eligible candidate')
   await expect(readRetainedContextFrame(current,querySources,async()=>true)).rejects.toBeDefined()
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const withdrawn=await authority(x)
   await expect(getMemoryHistory(nextId!,withdrawn.execution.security.access,withdrawn)).rejects.toBeDefined()
   expect((await read(x,nextId!)).isError).toBe(true)
   expect((await getAppPool().query("SELECT has_function_privilege(current_user,'record_admitted_memory_successor_derivation(uuid,text,uuid,text,text,jsonb,uuid,text)','EXECUTE') AS clone,has_table_privilege(current_user,'native_memory_successor_transitions','INSERT') AS raw")).rows).toEqual([{clone:false,raw:false}])
  }finally{await x.cleanup()}
 })
 it('carries actual attended source-backed and delegated native Memory history through model admission and current contraction',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const saved=await save(x,'governed',false),writer=await authority(x)
   const updated=await tools.saveMemory.execute({id:saved.id,detail:'Fictional history refinement'},writer.context)
   expect(updated.isError,JSON.stringify(updated)).not.toBe(true)
   const nextId=String(updated.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(nextId).toBeTruthy()
   const reader=await authority(x)
   const attendedHistory=await historyTools.getRowHistory.execute({primitive:'memories',row_id:nextId!},reader.context)
   expect(attendedHistory.isError,JSON.stringify(attendedHistory)).not.toBe(true)
   expect(attendedHistory.scopeEvidence?.sources?.some(source=>source.resourceKind==='application_field')).toBe(true)
   reader.accumulator.note(attendedHistory.scopeEvidence??{})
   await expect(assertSourceModelInputAuthority(reader.context)).resolves.toBeUndefined()
   const delegated={execution:await x.f.delegatedExecution(),accumulator:new ContextScopeAccumulator()}
   bindSessionContextRetainedAuthority(delegated.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
   const delegatedContext={...executionToolContext(delegated.execution,{appId:'fictional-history-tool'}),scopeAccumulator:delegated.accumulator} as ToolContext
   const delegatedHistory=await historyTools.getRowHistory.execute({primitive:'memories',row_id:saved.nativeSource.resourceId},delegatedContext)
   expect(delegatedHistory.isError,JSON.stringify(delegatedHistory)).not.toBe(true)
   expect(boundScopeSources(delegatedHistory.data as object).some(source=>source.resourceKind==='application_field')).toBe(true)
   delegated.accumulator.note(delegatedHistory.scopeEvidence??{})
   await expect(assertSourceModelInputAuthority(delegatedContext)).resolves.toBeUndefined()
   const serialized=JSON.parse(JSON.stringify({...reader.execution.security.access,authority:{execution:reader.execution,accumulator:reader.accumulator}}))
   await expect(historyStore.getRowHistory(serialized,{primitive:'memories',row_id:nextId!})).rejects.toBeDefined()
   expect((attendedHistory.data as {data:{chain:Array<{id:string}>}}).data.chain.map(row=>row.id)).toEqual([saved.id,nextId])
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const withdrawn=await authority(x)
   expect((await historyTools.getRowHistory.execute({primitive:'memories',row_id:nextId!},withdrawn.context)).isError).toBe(true)
   await expect(assertSourceModelInputAuthority(reader.context)).rejects.toBeDefined()
   await expect(assertSourceModelInputAuthority(delegatedContext)).resolves.toBeUndefined()
   await x.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[saved.nativeSource.resourceId])
   await expect(assertSourceModelInputAuthority(delegatedContext)).rejects.toBeDefined()

  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it.each(['session','member'] as const)('checks delegated native field history input and output against current %s authority',async contraction=>{
  const x=await sourceModeFixture('internal')
  try{
   const memory=await x.f.memory('Fictional delegated history control')
   const context=async()=>{
    const current={execution:await x.f.delegatedExecution(x.f.firstId),accumulator:new ContextScopeAccumulator()}
    bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
    const tool={...executionToolContext(current.execution,{appId:'fictional-delegated-history'}),scopeAccumulator:current.accumulator} as ToolContext
    const history=await historyTools.getRowHistory.execute({primitive:'memories',row_id:memory.id},tool)
    expect(history.isError,JSON.stringify(history)).not.toBe(true)
    current.accumulator.note(history.scopeEvidence??{})
    expect(current.accumulator.evidence.sources?.some(source=>source.resourceKind==='application_field')).toBe(true)
    expect(current.execution.identity).toMatchObject({kind:'delegated',actorUserId:x.f.firstId,parentCeiling:{userId:x.f.firstId,workspaceId:x.f.workspaceId}})
    return tool
   }
   const incoming=await context(),outgoing=await context()
   await expect(assertSourceModelInputAuthority(incoming)).resolves.toBeUndefined()
   await expect(assertSourceModelOutputAuthority(outgoing)).resolves.toBeUndefined()
   const incomingBefore=structuredClone(incoming.scopeAccumulator!.evidence),outgoingBefore=structuredClone(outgoing.scopeAccumulator!.evidence)
   const parentBefore=structuredClone(incoming.executionContext!.identity)
   if(contraction==='session')await x.f.pool.query('DELETE FROM sessions WHERE id=$1',[x.f.session.id])
   else await x.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[x.f.workspaceId,x.f.firstId])
   await expect(assertSourceModelInputAuthority(incoming)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
   await expect(assertSourceModelOutputAuthority(outgoing)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
   expect(incoming.scopeAccumulator!.evidence).toEqual(incomingBefore);expect(outgoing.scopeAccumulator!.evidence).toEqual(outgoingBefore)
   expect(incoming.executionContext!.identity).toEqual(parentBefore)
  }finally{await x.cleanup()}
 })
 it('rolls back an incorrect write mask and stale admitted version without publishing a successor or retirement',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x,'governed',false),current=await authority(x),access=current.execution.security.access
   const prior=await store.getById(access,saved.id,current);expect(prior).not.toBeNull()
   const snapshot=async()=>(await x.f.pool.query('SELECT id,summary,detail,scope_version,scope_held,valid_to,superseded_by FROM memories WHERE workspace_id=$1 ORDER BY id',[x.f.workspaceId])).rows
   const before=await snapshot()
   await expect(store.update(saved.id,{summary:'Fictional mask mismatch'},access,{authority:current,expectedVersion:prior!.scopeVersion!,writeFields:['detail']})).rejects.toBeDefined()
   expect(await snapshot()).toEqual(before)
   await expect(store.update(saved.id,{detail:'Fictional stale edit'},access,{authority:current,expectedVersion:String(BigInt(prior!.scopeVersion!)+1n),writeFields:['detail']})).rejects.toMatchObject({message:'scope_source_changed'})
   expect(await snapshot()).toEqual(before)
   expect((await x.f.pool.query('SELECT predecessor_id FROM native_memory_successor_transitions WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([])
   const contenders=await Promise.all([authority(x),authority(x)])
   const raced=await Promise.allSettled(contenders.map((actor,index)=>store.update(saved.id,{detail:`Fictional concurrent edit ${index}`},actor.execution.security.access,
    {authority:actor,expectedVersion:prior!.scopeVersion!,writeFields:['detail']})))
   expect(raced.filter(result=>result.status==='fulfilled'&&result.value!==null)).toHaveLength(1)
   expect((await x.f.pool.query('SELECT predecessor_id FROM native_memory_successor_transitions WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([{predecessor_id:saved.id}])
  }finally{await x.cleanup()}
 })
 it('refuses a protected successor after independent source withdrawal and keeps historical data unchanged',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await save(x,'governed',false),current=await authority(x),access=current.execution.security.access
   const prior=await store.getById(access,saved.id,current);expect(prior).not.toBeNull()
   const before=(await x.f.pool.query('SELECT id,summary,detail,scope_version,scope_held,valid_to,superseded_by FROM memories WHERE workspace_id=$1 ORDER BY id',[x.f.workspaceId])).rows
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   await expect(store.update(saved.id,{detail:'Fictional source-denied successor'},access,{authority:current,expectedVersion:prior!.scopeVersion!,writeFields:['detail']})).rejects.toBeDefined()
   expect((await x.f.pool.query('SELECT id,summary,detail,scope_version,scope_held,valid_to,superseded_by FROM memories WHERE workspace_id=$1 ORDER BY id',[x.f.workspaceId])).rows).toEqual(before)
   expect((await x.f.pool.query('SELECT predecessor_id FROM native_memory_successor_transitions WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([])
  }finally{await x.cleanup()}
 })
 it.each([
  {name:'checks only the requested write fields against current deployed Memory roles and stops a contracted detail writer',legacyProfile:false},
  {name:'accepts exact canonical legacy Memory read policies while refusing unknown digests and subsequent legacy mask drift',legacyProfile:true},
 ])('$name',async({legacyProfile})=>{
  const x=await sourceModeFixture('internal');let registered=false
  try{
   const saved=legacyProfile?{id:(await x.f.memory('Fictional independent native input')).id}:await save(x,'governed',false)
   await x.f.pool.query(`CREATE FUNCTION memory_successor_field_catalog(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
     'fieldKeys',application_memory_field_keys(),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='detail' THEN '[["reader"]]'::jsonb ELSE '[]'::jsonb END,
      'write',CASE WHEN key='detail' THEN '[["editor"]]'::jsonb ELSE '[]'::jsonb END,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key),
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
    REVOKE ALL ON FUNCTION memory_successor_field_catalog(uuid,jsonb,text) FROM PUBLIC;
    CREATE FUNCTION memory_successor_field_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT (memory_successor_field_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id))
     FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
    REVOKE ALL ON FUNCTION memory_successor_field_reader(uuid,jsonb,text,text) FROM PUBLIC;
    INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
     VALUES('native','1',ARRAY['editor','reader'],'memory_successor_field_reader(uuid,jsonb,text,text)'::regprocedure,'memory_successor_field_catalog(uuid,jsonb,text)'::regprocedure)`)
   registered=true
   await x.f.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
    VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[x.f.workspaceId])
   await x.f.pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
    VALUES($1,'native',$2,'editor',$2),($1,'native',$2,'reader',$2)`,[x.f.workspaceId,x.f.ownerId])
   const current=await authority(x),prior=await store.getById(current.execution.security.access,saved.id,current)
   expect(prior).not.toBeNull()
   if(legacyProfile){
   // Capture real pre-v2 observations through the unchanged canonical readers.
   // Both definitions are restored even if a reader refuses; no raw observation
   // or metadata write is granted to the application role.
   const definitions=(await x.f.pool.query<{definition:string}>(`SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE oid=ANY(ARRAY['application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure,
     'application_memory_historical_field_state(uuid,uuid,text[])'::regprocedure])`)).rows.map(row=>row.definition)
   const selected="'policyVersion',application_field_digest(jsonb_build_object('kind','memory-read-v2','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','selectedRead',jsonb_build_object('fields',fields,'allowed',true)))"
   const legacy="'policyVersion',application_field_digest(jsonb_build_object('kind','memory-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask))"
   let legacySources:ScopeSource[]=[],unknownSources:ScopeSource[]=[]
   try{
    for(const definition of definitions){expect(definition.split(selected)).toHaveLength(2);await x.f.pool.query(definition.replace(selected,legacy))}
    const oldReader=await authority(x),oldPoint=await store.getById(oldReader.execution.security.access,saved.id,oldReader)
    const oldQuery=await store.search(oldReader.execution.security.access,{query:'source-backed'},oldReader)
    const oldHistory=await getMemoryHistory(saved.id,oldReader.execution.security.access,oldReader)
    legacySources=[...boundScopeSources(oldPoint!),...boundScopeSources(oldQuery),...boundScopeSources(oldHistory)]
    expect(legacySources.length).toBeGreaterThan(2)
    for(const definition of definitions)await x.f.pool.query(definition.replace(selected,"'policyVersion',repeat('a',64)"))
    const unknownReader=await authority(x),unknownPoint=await store.getById(unknownReader.execution.security.access,saved.id,unknownReader)
    unknownSources=boundScopeSources(unknownPoint!);expect(unknownSources.length).toBeGreaterThan(0)
   }finally{for(const definition of definitions)await x.f.pool.query(definition)}
   const compatibility=await authority(x)
   await expect(readRetainedContextFrame(compatibility,legacySources,async()=>true)).resolves.toBe(true)
   await expect(readRetainedContextFrame(compatibility,unknownSources,async()=>true)).rejects.toBeDefined()
   const currentPoint=await store.getById(current.execution.security.access,saved.id,current)
   const currentQuery=await store.search(current.execution.security.access,{query:'source-backed'},current)
   const currentHistory=await getMemoryHistory(saved.id,current.execution.security.access,current)
   const currentSources=[...boundScopeSources(currentPoint!),...boundScopeSources(currentQuery),...boundScopeSources(currentHistory)]
   const selectedRows=await readRetainedContextFrame(current,[],async db=>(await db.query<{value:{row:{summary:string}|null;sources:ScopeSource[]}}>(
    "SELECT value FROM read_native_memory_query_projection($1,ARRAY['summary'],false)",[x.f.workspaceId])).rows.map(row=>row.value))
   expect(selectedRows.some(row=>row.row?.summary==='Fictional independent native input')).toBe(true)
   const selectedSources=selectedRows.flatMap(row=>row.sources)

   await x.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND role_key='editor'",[x.f.workspaceId])
   const afterWriteContraction=await authority(x)
   await expect(readRetainedContextFrame(afterWriteContraction,currentSources,async()=>true)).resolves.toBe(true)
   await expect(readRetainedContextFrame(afterWriteContraction,legacySources,async()=>true)).rejects.toBeDefined()
   await x.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND role_key='reader'",[x.f.workspaceId])
   const readDenied=await authority(x)
   await expect(readRetainedContextFrame(readDenied,selectedSources,async()=>true)).resolves.toBe(true)
   await expect(readRetainedContextFrame(readDenied,currentSources,async()=>true)).rejects.toBeDefined()
   return
   }
   const query=await store.search(current.execution.security.access,{query:'source-backed'},current)
   const history=await getMemoryHistory(saved.id,current.execution.security.access,current)
   const pointQuerySources=[...boundScopeSources(prior!),...boundScopeSources(query)]
   const historySources=boundScopeSources(history)
   const first=await tools.saveMemory.execute({id:saved.id,detail:'Fictional permitted detail'},current.context)
   expect(first.isError,JSON.stringify(first)).not.toBe(true)
   const nextId=String(first.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(nextId).toBeTruthy()
   await x.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND role_key='editor'",[x.f.workspaceId])
   const afterWriteContraction=await authority(x)
   // The native successor changes current audit-history status. It must not
   // renew the earlier H, while ordinary point/query READ compatibility survives
   // the independent WRITE-only role contraction.
   await expect(readRetainedContextFrame(afterWriteContraction,pointQuerySources,async()=>true)).resolves.toBe(true)
   await expect(readRetainedContextFrame(afterWriteContraction,historySources,async()=>true)).rejects.toBeDefined()
   const freshHistory=await getMemoryHistory(nextId!,afterWriteContraction.execution.security.access,afterWriteContraction)
   expect(freshHistory.chain.map(row=>row.id)).toEqual([saved.id,nextId])
   await expect(readRetainedContextFrame(afterWriteContraction,boundScopeSources(freshHistory),async()=>true)).resolves.toBe(true)
   const summaryActor=await authority(x),second=await tools.saveMemory.execute({id:nextId!,summary:'Fictional permitted summary'},summaryActor.context)
   expect(second.isError,JSON.stringify(second)).not.toBe(true)
   const head=String(second.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(head).toBeTruthy()
   const denied=await authority(x)
   await expect(tools.saveMemory.execute({id:head!,detail:'Fictional permitted detail'},denied.context)).rejects.toBeDefined()
   expect((await x.f.pool.query('SELECT detail,valid_to FROM memories WHERE id=$1',[head])).rows).toEqual([{detail:'Fictional permitted detail',valid_to:null}])
   await x.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND role_key='reader'",[x.f.workspaceId])
   const readDenied=await authority(x)
   await expect(getMemoryHistory(head!,readDenied.execution.security.access,readDenied)).rejects.toBeDefined()
   expect((await read(x,head!)).isError).toBe(true)
  }finally{
   await x.f.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   await x.f.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   if(registered)await x.f.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await x.f.pool.query('DROP FUNCTION IF EXISTS memory_successor_field_reader(uuid,jsonb,text,text),memory_successor_field_catalog(uuid,jsonb,text)')
   await x.cleanup()
  }
 },60_000)

})
