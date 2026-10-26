import {readCurrentScopeSources} from '../../db/derived-scope-store.js'
/** Current audit history uses real native-session authority and current per-version rights. */
import {describe,it,expect,beforeEach,afterEach,afterAll} from 'vitest'
import type {PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {ContextScopeAccumulator,boundScopeSources,createCorrectionTools,executionToolContext,type AccessCeiling} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createMemoryRetractionStore} from '../../db/retraction-store.js'
import {createSoftDeleteStore} from '../../db/soft-delete-store.js'
import {createSensitivityReclassificationStore} from '../../db/sensitivity-reclassification-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {readRetainedQueryFrame,readRetainedContextFrame,writeRetainedContextFrame} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
import {originalMemoryAuthority,saveOriginalMemory} from './fixtures/retained-memory.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {createDbContextScopeStore} from '../../db/context-scope-store.js'
import {createDbSavedViewStore} from '../../db/saved-views-store.js'
import {getMemoryHistory,createMemory as legacyCreate,updateMemory as legacyUpdate} from '../../db/memories.js'
import {executeWorkspaceScopeReview} from '../../workspace-access/scope-review.js'
import {validateCallerScopeEvidence,validateAudienceScopeEvidence} from '../../context-scope/caller-evidence.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),memoryStore=createDbMemoryStore()
afterAll(async()=>{await getAppPool().end();await pool.end()})
describe.sequential('[COMP:corrections/row-history] current native Memory audit history',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>,userId:string,assistantId:string,workspaceId:string
 let nativeSession:Awaited<ReturnType<typeof createPersonalWebSession>>,credential:Readonly<{userId:string;sessionId:string;authVersion:number}>
 beforeEach(async()=>{
  fixture=await persistentContextFixture();userId=fixture.ownerId;assistantId=fixture.assistantId;workspaceId=fixture.workspaceId
  const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional correction device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual correction auth session')
  credential=Object.freeze({userId,sessionId:auth.id,authVersion:auth.authVersion})
  nativeSession=await createPersonalWebSession({assistantId,userId,workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion})
 })
 afterEach(async()=>{
  await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
  await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
  await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
  await pool.query('DROP FUNCTION IF EXISTS fixture_history_reader(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS fixture_history_catalog(uuid,jsonb,text)')
  await fixture?.cleanup()
 })
 async function authority(onCredentialCurrent?:()=>Promise<void>){
  const assistant=await findAssistantById(assistantId);if(!assistant)throw new Error('Missing actual correction assistant')
  const resolved=await resolveExecutionContextSystem({userId,workspaceId,assistant,memberMode:'member',sharedAudience:false,session:nativeSession,sessionAuthority:nativeSession,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
   lifecycle:{sessionId:nativeSession.id,sessionPersisted:true,channelType:'web',channelId:nativeSession.channelId,abortSignal:new AbortController().signal},
   credentialCurrent:async()=>{const current=!!await authSessionStore.validateAccess(credential);if(current)await onCredentialCurrent?.();return current}})
  return{execution:resolved.executionContext,accumulator:new ContextScopeAccumulator()}
 }
 async function createMemory(params:Omit<Parameters<typeof memoryStore.create>[0],'authority'>){return memoryStore.create({...params,workspaceId,authority:await authority()})}
 async function updateMemory(id:string,updates:{summary:string}){
  const current=await authority(),access=current.execution.security.access,prior=await memoryStore.getById(access,id,current);expect(prior).not.toBeNull()
  const next=await memoryStore.update(id,updates,access,{authority:current,expectedVersion:prior!.scopeVersion!,writeFields:['summary']});expect(next).not.toBeNull();return next
 }
 async function withNativeTransaction<T>(action:(client:PoolClient)=>Promise<T>){return readRetainedContextFrame(await authority(),[],action)}
 async function retractUsingTool(memoryId:string,current?:Awaited<ReturnType<typeof authority>>){
  const host=current??await authority(),tools=createCorrectionTools({retraction:createMemoryRetractionStore(),softDelete:createSoftDeleteStore(),reclassify:createSensitivityReclassificationStore(),
   resolveWorkspaceRole:async(id,workspace)=>(await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,id])).rows[0]?.role??null})
  return tools.find(tool=>tool.name==='retractMemory')!.execute({memory_id:memoryId,reason:'Fictional native correction'},
   {...executionToolContext(host.execution,{appId:'fictional-correction'}),scopeAccumulator:host.accumulator})
 }


 async function switchActor(actor:string){
  userId=actor
  const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional history member device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual member session')
  credential=Object.freeze({userId,sessionId:auth.id,authVersion:auth.authVersion})
  nativeSession=await createPersonalWebSession({assistantId,userId,workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion})
 }
 async function history(id:string,host?:Awaited<ReturnType<typeof authority>>){const current=host??await authority();return getMemoryHistory(id,current.execution.security.access,current)}
 async function currentPort(id:string,version:string,workspace=workspaceId){
  const current=await authority()
  return readRetainedQueryFrame(current,[],async client=>{
   const raw=(await client.query('SELECT read_native_memory_history_projection($1,$2,$3) AS value',[workspace,id,version])).rows[0].value
   return{value:raw,sources:raw?.sources??[]}
  })
 }
 async function state(id:string){return(await pool.query("SELECT m.scope_version::text AS version,m.scope_held,m.valid_to,m.retracted_at,s.review_state,s.classification_revision::text,s.holding_reason FROM memories m LEFT JOIN scope_resource_states s ON s.workspace_id=m.workspace_id AND s.resource_kind='memory' AND s.resource_id=m.id AND s.resource_version=m.scope_version::text WHERE m.id=$1",[id])).rows[0]}
 async function hold(id:string){
  const review=await executeWorkspaceScopeReview(workspaceId,fixture.ownerId,{type:'scope.review.preview',resourceKind:'memory',resourceIds:[id],action:'hold',targetTeamId:null,reason:'Fictional independent administrator hold'})
  return executeWorkspaceScopeReview(workspaceId,fixture.ownerId,{type:'scope.review.apply',reviewId:review.id,expectedVersion:review.version,payloadHash:review.payloadHash})
 }
 async function registerPolicy(){
  await pool.query(`CREATE FUNCTION fixture_history_catalog(w uuid,o jsonb,t text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
    'fieldKeys',application_memory_field_keys(),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read','[["history_reader"]]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key),
    'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
   CREATE FUNCTION fixture_history_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   SELECT (fixture_history_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id),
    'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='summary' THEN CASE WHEN m.valid_to IS NOT NULL THEN '[["history_reader"],["past_reader"]]'::jsonb ELSE '[["history_reader"],["head_reader"]]'::jsonb END ELSE '[["history_reader"]]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key)) FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
   REVOKE ALL ON FUNCTION fixture_history_catalog(uuid,jsonb,text),fixture_history_reader(uuid,jsonb,text,text) FROM PUBLIC;
   INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
    VALUES('native','1',ARRAY['history_reader','past_reader','head_reader'],'fixture_history_reader(uuid,jsonb,text,text)'::regprocedure,'fixture_history_catalog(uuid,jsonb,text)'::regprocedure)`)
  await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[workspaceId])
  for(const role of ['history_reader','past_reader','head_reader'])await pool.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,$3,$4)",[workspaceId,userId,role,fixture.ownerId])
 }
 it('keeps current per-version roles for a genuine ordinary member',async()=>{
  await switchActor(fixture.secondId)
  expect((await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId])).rows).toEqual([{role:'member'}])
  const row=await createMemory({assistantId,userId,summary:'Fictional historical member value',sensitivity:'internal',createdByUserId:userId})
  const successor=(await updateMemory(row.id,{summary:'Fictional current member value'}))!
  const independentHead=await createMemory({assistantId,userId,summary:'Fictional independently readable current head',sensitivity:'internal',createdByUserId:userId})
  await registerPolicy()
  const fresh=await history(row.id)
  expect(boundScopeSources(fresh).length).toBeGreaterThan(0)
  expect(fresh.chain.map(x=>x.summary)).toEqual(['Fictional historical member value','Fictional current member value'])
  expect(fresh.currentId).toBe(successor.id)
  await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND role_key='past_reader'",[workspaceId,userId])
  await expect(history(row.id)).rejects.toThrow()
  const current=await authority();expect(await memoryStore.getById(current.execution.security.access,independentHead.id,current)).not.toBeNull()
  await expect(memoryStore.getById(current.execution.security.access,successor.id,await authority())).rejects.toThrow()
  await pool.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'past_reader',$3)",[workspaceId,userId,fixture.ownerId])
  expect((await history(row.id)).chain).toHaveLength(2)
  const beforeCatalog=boundScopeSources(await history(row.id))
  await pool.query("UPDATE application_native_field_contracts SET contract_version='2' WHERE module_key='native'")
  await expect(readRetainedContextFrame(await authority(),beforeCatalog,async()=>true)).rejects.toThrow()
 })
 it('admits only exact retired own fields from a genuine retraction and keeps every independent reason current',async()=>{
  const root=await createMemory({assistantId,userId,summary:'Fictional earlier history',sensitivity:'internal',createdByUserId:userId})
  const reason=await createMemory({assistantId,userId,summary:'Fictional independent reason',sensitivity:'internal',createdByUserId:userId})
  const successor=(await updateMemory(root.id,{summary:'Fictional corrected history'}))!
  const used=await authority(),own=await memoryStore.getById(used.execution.security.access,successor.id,used),independent=await memoryStore.getById(used.execution.security.access,reason.id,used)
  used.accumulator.note({sources:[...boundScopeSources(own!),...boundScopeSources(independent!)]})
  const narrow=await readRetainedQueryFrame(await authority(),[],async client=>{
   const raw=(await client.query("SELECT observe_application_field_projection($1,'{\"kind\":\"native\",\"moduleKey\":\"native\"}','memory',$2,$3,'read',NULL,ARRAY['summary']) AS value",[workspaceId,successor.id,successor.scopeVersion])).rows[0].value
   return{value:raw,sources:raw.sources}
  })
  const before=await history(root.id),old=boundScopeSources(before)
  expect((await retractUsingTool(successor.id,used)).isError).not.toBe(true)
  const status=await state(successor.id),receipt=(await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL',[workspaceId,successor.id])).rows[0].value
  expect(receipt.resultHoldState).toMatchObject({resourceId:successor.id,resourceVersion:status.version,classificationRevision:status.classification_revision,holdingReason:status.holding_reason})
  const result=await history(successor.id)
  expect(result.chain.map(x=>x.summary)).toEqual(['Fictional earlier history','Fictional corrected history'])
  expect(result.chain[1].retractedAt).toBeInstanceOf(Date)
  await expect(readRetainedContextFrame(await authority(),old,async()=>true)).rejects.toThrow()
  await expect(readRetainedContextFrame(await authority(),boundScopeSources(own!),async()=>true)).rejects.toThrow()
  await expect(readRetainedContextFrame(await authority(),narrow.sources,async()=>true)).rejects.toThrow()
  const high=await authority();high.accumulator.note({sources:boundScopeSources(independent!)})
  expect((await retractUsingTool(reason.id)).isError).not.toBe(true)
  await expect(history(successor.id)).rejects.toThrow()
  await expect(history(crypto.randomUUID(),high)).rejects.toThrow('scope_source_changed')
  expect((await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2',[workspaceId,successor.id])).rows[0].value).toEqual(receipt)
 })
 it('does not turn an explicit later hold into the retraction own hold',async()=>{
  const row=await createMemory({assistantId,userId,summary:'Fictional unheld correction target',sensitivity:'internal',createdByUserId:userId})
  expect((await retractUsingTool(row.id)).isError).not.toBe(true)
  expect((await history(row.id)).chain).toHaveLength(1)
  const before=await state(row.id),sources=boundScopeSources(await history(row.id))
  await hold(row.id)
  const after=await state(row.id);expect(after.version).toBe(before.version);expect(after.holding_reason).toBe('administrator_review')
  await expect(history(row.id)).rejects.toThrow()
  await expect(readRetainedContextFrame(await authority(),sources,async()=>true)).rejects.toThrow()
 })
 it('admits a truthful legacy chain but refuses a protected chain with no native transition',async()=>{
  const row=await legacyCreate({assistantId,userId,workspaceId,summary:'Fictional legacy first',sensitivity:'internal',createdByUserId:userId})
  const before=await history(row.id),old=boundScopeSources(before)
  const current=await authority(),next=(await legacyUpdate(row.id,{summary:'Fictional legacy second'},current.execution.security.access))!
  expect((await state(row.id)).version).toBe(row.scopeVersion)
  await expect(readRetainedContextFrame(await authority(),old,async()=>true)).rejects.toThrow('scope_source_changed')
  expect((await history(row.id)).chain.map(x=>x.id)).toEqual([row.id,next.id])
  expect((await pool.query('SELECT * FROM native_memory_successor_transitions WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
  const protectedRow=await legacyCreate({assistantId,userId,workspaceId,summary:'Fictional protected legacy',sourceSessionId:nativeSession.id,sensitivity:'internal',createdByUserId:userId})
  const protectedNext=await legacyUpdate(protectedRow.id,{summary:'Fictional protected successor'},current.execution.security.access)
  expect(protectedNext).not.toBeNull()
  await expect(history(protectedRow.id)).rejects.toThrow('scope_source_changed')
 })
 it('preserves a truthful legacy prefix followed by an authenticated native successor',async()=>{
  const first=await legacyCreate({assistantId,userId,workspaceId,summary:'Fictional mixed legacy first',sensitivity:'internal',createdByUserId:userId})
  const human=await authority(),second=(await legacyUpdate(first.id,{summary:'Fictional mixed legacy second'},human.execution.security.access))!
  expect(second).not.toBeNull()
  const third=(await updateMemory(second.id,{summary:'Fictional mixed native third'}))!
  const transition=(await pool.query('SELECT predecessor_id,successor_id FROM native_memory_successor_transitions WHERE workspace_id=$1 ORDER BY predecessor_id',[workspaceId])).rows
  expect(transition).toEqual([{predecessor_id:second.id,successor_id:third.id}])
  const result=await history(first.id)
  expect(result.chain.map(x=>x.summary)).toEqual(['Fictional mixed legacy first','Fictional mixed legacy second','Fictional mixed native third'])
  expect(result.currentId).toBe(third.id)
 })
 it('keeps missing/foreign/version refusal and private helper access separate from human authority',async()=>{
  const row=await createMemory({assistantId,userId,summary:'Fictional exact history target',sensitivity:'internal',createdByUserId:userId})
  expect(await currentPort(row.id,'999')).toBeNull();expect(await currentPort(row.id,row.scopeVersion!,crypto.randomUUID())).toBeNull()
  await expect(getAppPool().query('SELECT application_memory_history_status($1,$2,$3)',[workspaceId,row.id,row.scopeVersion])).rejects.toMatchObject({code:'42501'})
  const actual=boundScopeSources(await history(row.id))
  const args=[workspaceId,actual.map(source=>source.resourceKind),actual.map(source=>source.resourceId),actual.map(source=>source.version)]
  const unauthenticated=await getAppPool().connect()
  try{
   await unauthenticated.query('BEGIN')
   const profile=(await unauthenticated.query("SELECT session_user,current_user,current_setting('app.current_user_id',true) AS actor,nullif(current_setting('app.application_id',true),'') AS application,nullif(current_setting('app.public_share_root',true),'') AS public_share")).rows[0]
   expect(profile).toEqual({session_user:'app_user',current_user:'app_user',actor:'00000000-0000-0000-0000-000000000000',application:null,public_share:null})
   expect((await unauthenticated.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value).toBeNull()
   for(const actor of ['',crypto.randomUUID()]){
    await unauthenticated.query("SELECT set_config('app.current_user_id',$1,true)",[actor])
    expect((await unauthenticated.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value).toBeNull()
   }
  }finally{await unauthenticated.query('ROLLBACK');unauthenticated.release()}

  await withNativeTransaction(async client=>{
   const metadata=(await client.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value
   expect(metadata).toMatchObject({purpose:'memory_history',available:true});expect(Object.hasOwn(metadata,'admitted')).toBe(false)
   for(const key of ['app.application_id','app.public_share_root']){
    await client.query('SELECT set_config($1,$2,true)',[key,crypto.randomUUID()])
    expect((await client.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value).toBeNull()
    await client.query('SELECT set_config($1,$2,true)',[key,''])
   }
  })
  const owner=await pool.connect()
  try{await owner.query('BEGIN');await owner.query("SELECT set_config('app.current_user_id',$1,true)",[userId]);expect((await owner.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0].value).toBeNull()}
  finally{await owner.query('ROLLBACK');owner.release()}
  const current=await authority();expect((await history(crypto.randomUUID(),current)).chain).toEqual([])
  expect(await authSessionStore.revokeForUser(userId,credential.sessionId)).toBe(true)
  await expect(history(crypto.randomUUID(),current)).rejects.toThrow()
 })
 it('validates complete scalar high-water and current membership even for an absent id',async()=>{
  await pool.query("UPDATE assistants SET clearance='internal' WHERE id=$1",[assistantId])
  await switchActor(fixture.firstId)
  const current=await authority();current.accumulator.note({sensitivity:'confidential'})
  await expect(history(crypto.randomUUID(),current)).rejects.toThrow()
  let pause=false,entered!:()=>void,resume!:()=>void
  const atCredential=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{resume=resolve})
  const entry=await authority(async()=>{if(pause){entered();await released}})
  entry.accumulator.note({sensitivity:'confidential'});pause=true
  const attempt=history(crypto.randomUUID(),entry)
  await atCredential
  entry.accumulator=new ContextScopeAccumulator()
  resume()
  await expect(attempt).rejects.toThrow()
  const member=await authority()
  await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId])
  await expect(history(crypto.randomUUID(),member)).rejects.toThrow()
 })
 it('refreshes genuine expired context authority after capture and refuses source withdrawal without replay',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const current=await originalMemoryAuthority(x),observed=await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   expect(observed.sources.length).toBeGreaterThan(0)
   let captures=0
   const result=await readRetainedQueryFrame(current,observed.sources,async client=>{
    captures++
    const before=await readCurrentScopeSources(client,x.f.workspaceId,observed.sources,undefined,'context',true)
    expect(before).toHaveLength(observed.sources.length)
    expect(before.every(row=>row.state==='current')).toBe(true)
    // Observe the real authorization decision across its bounded lifetime.
    await new Promise(resolve=>setTimeout(resolve,5_100))
    const expired=await readCurrentScopeSources(client,x.f.workspaceId,observed.sources,undefined,'context',true)
    expect(expired).toHaveLength(observed.sources.length)
    expect(expired.every(row=>row.state==='held')).toBe(true)
    return{value:'Fictional capture completed once',sources:observed.sources}
   })
   expect(result).toBe('Fictional capture completed once');expect(captures).toBe(1)
   const withdrawn=await originalMemoryAuthority(x)
   await expect(readRetainedQueryFrame(withdrawn,observed.sources,async()=>{
    captures++
    await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
    return{value:'must not escape',sources:observed.sources}
   })).rejects.toBeDefined()
   expect(captures).toBe(2)
  }finally{await x.cleanup()}
 })
 it('preserves each original root across mixed and cross-chunk history projection and enforces recipient floors',async()=>{
  const root=await createMemory({assistantId,userId,summary:'Fictional chunk predecessor',sensitivity:'internal',createdByUserId:userId})
  const successor=(await updateMemory(root.id,{summary:'Fictional chunk successor'}))!
  const before=await authority(),point=await memoryStore.getById(before.execution.security.access,successor.id,before)
  const originalPointSources=boundScopeSources(point!)
  expect(originalPointSources.length).toBeGreaterThan(0)
  const targetField=(await pool.query("SELECT id FROM application_field_resources WHERE workspace_id=$1 AND resource_id=$2 AND selection='read' AND selected_version IS NULL AND fields=ARRAY(SELECT key FROM unnest(application_memory_field_keys()) key ORDER BY key)",[workspaceId,successor.id])).rows[0].id
  expect(originalPointSources.some(source=>source.resourceId===targetField)).toBe(true)
  expect((await retractUsingTool(successor.id)).isError).not.toBe(true)
  const second=await createMemory({assistantId,userId,summary:'Fictional independent current input',sensitivity:'internal',createdByUserId:userId})
  const roots=[...boundScopeSources(await history(root.id)),...boundScopeSources(await history(second.id))]
  const padding=await readRetainedQueryFrame(await authority(),[],async client=>{
   const keys=(await pool.query('SELECT application_memory_field_keys() AS keys')).rows[0].keys as string[]
   const selections:string[][]=[]
   for(let a=0;a<keys.length&&selections.length<101;a++)for(let b=a+1;b<keys.length&&selections.length<101;b++)selections.push([keys[a],keys[b]])
   expect(selections).toHaveLength(101)
   const sources=[]
   for(const fields of selections){
    const raw=(await client.query("SELECT observe_application_field_projection($1,'{\"kind\":\"native\",\"moduleKey\":\"native\"}','memory',$2,$3,'read',NULL,$4) AS value",[workspaceId,second.id,second.scopeVersion,fields])).rows[0].value
    sources.push(...raw.sources)
   }
   return{value:sources,sources}
  })
  expect(new Set(padding.map(source=>source.resourceId)).size).toBe(101)
  const mixed=[...roots,...padding],host=await authority()
  await expect(readRetainedContextFrame(host,mixed,async client=>{
   expect((await validateCallerScopeEvidence({sources:mixed},host.execution.security.ceiling,client)).sources?.some(source=>source.resourceId===roots[0].resourceId)).toBe(true)
   await validateAudienceScopeEvidence({sources:roots},host.execution.security.ceiling,client)
   await expect(validateAudienceScopeEvidence({sources:roots},{...host.execution.security.ceiling,clearance:'public',departmentRead:undefined},client)).rejects.toBeDefined()
   return true
  })).resolves.toBe(true)
  // More than100 distinct roots precede this independently supplied old tuple.
  expect(mixed.length).toBeGreaterThan(100)
  await expect(readRetainedContextFrame(await authority(),[...mixed,...boundScopeSources(point!)],async()=>true)).rejects.toThrow()
  const field=roots[0]
  await expect(readRetainedContextFrame(await authority(),[{...field,userId:field.userId===null?userId:null}],async()=>true)).rejects.toThrow()
 })
 it('does not qualify a distinct same-row field observation supplied in the retraction receipt',async()=>{
  const row=await createMemory({assistantId,userId,summary:'Fictional distinct receipt reference',sensitivity:'internal',createdByUserId:userId})
  const narrow=await readRetainedQueryFrame(await authority(),[],async client=>{
   const raw=(await client.query("SELECT observe_application_field_projection($1,'{\"kind\":\"native\",\"moduleKey\":\"native\"}','memory',$2,$3,'read',NULL,ARRAY['summary']) AS value",[workspaceId,row.id,row.scopeVersion])).rows[0].value
   return{value:raw,sources:raw.sources}
  })
  const used=await authority();used.accumulator.note({sources:narrow.sources})
  const result=await retractUsingTool(row.id,used)
  if(result.isError)expect(String(result.data)).toContain('may have committed')
  const receipts=(await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL',[workspaceId,row.id])).rows
  expect(receipts).toHaveLength(1)
  expect(receipts[0].value.originalRoots).toContainEqual({kind:'application_field',id:narrow.sources[0].resourceId,version:narrow.sources[0].version})
  await expect(history(row.id)).rejects.toThrow()
 })
 it('revalidates root-only external history at actual model context and delivery boundaries',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const saved=await saveOriginalMemory(x),correction=await originalMemoryAuthority(x)
   const read=await correction.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   correction.accumulator.note({sources:read.sources})
   expect((await retractUsingTool(saved.id,correction)).isError).not.toBe(true)
   const reader=await originalMemoryAuthority(x),captured=await getMemoryHistory(saved.id,reader.execution.security.access,reader)
   const all=boundScopeSources(captured)
   const historyFields=(await x.f.pool.query("SELECT id FROM application_field_resources WHERE workspace_id=$1 AND resource_id=$2 AND selection='history'",[x.f.workspaceId,saved.id])).rows.map(row=>row.id)
   const roots=all.filter(source=>source.resourceKind==='application_field'&&historyFields.includes(source.resourceId))
   expect(roots).toHaveLength(1)
   const full=await originalMemoryAuthority(x);full.accumulator.note({sources:all})
   await expect(assertSourceModelInputAuthority(full.context)).resolves.toBeUndefined()
   const tool=async()=>{const host=await originalMemoryAuthority(x);host.accumulator.note({sources:roots});return host.context}
   await expect(assertSourceModelInputAuthority(await tool())).resolves.toBeUndefined()
   await expect(assertSourceModelOutputAuthority(await tool())).resolves.toBeUndefined()
   await x.sourcePool.query("UPDATE grants SET actions=array_remove(actions,'deliver') WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   await expect(assertSourceModelInputAuthority(await tool())).resolves.toBeUndefined()
   await expect(assertSourceModelOutputAuthority(await tool())).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   await expect(assertSourceModelInputAuthority(await tool())).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('keeps a distinct independent parent path to the own field and raw anchor ordinary',async()=>{
  const row=await createMemory({assistantId,userId,summary:'Fictional independent-path target',sensitivity:'internal',createdByUserId:userId})
  const producer=await authority(),point=await memoryStore.getById(producer.execution.security.access,row.id,producer)
  producer.accumulator.note({sources:boundScopeSources(point!)})
  const parent=await memoryStore.create({assistantId,userId,workspaceId,summary:'Fictional independent-path parent',sensitivity:'internal',createdByUserId:userId,authority:producer})
  const correction=await authority(),input=await memoryStore.getById(correction.execution.security.access,parent.id,correction)
  correction.accumulator.note({sources:boundScopeSources(input!)})
  const result=await retractUsingTool(row.id,correction)
  if(result.isError)expect(String(result.data)).toContain('may have committed')
  const receipt=(await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL',[workspaceId,row.id])).rows
  expect(receipt).toHaveLength(1)
  const own=(await pool.query("SELECT f.id,o.version FROM application_field_resources f JOIN application_field_observations o ON o.workspace_id=f.workspace_id AND o.resource_id=f.id WHERE f.workspace_id=$1 AND f.resource_id=$2 AND f.selection='read' AND f.selected_version IS NULL AND f.fields=ARRAY(SELECT key FROM unnest(application_memory_field_keys()) key ORDER BY key) AND o.source_version=$3",[workspaceId,row.id,row.scopeVersion])).rows
  expect(own).toHaveLength(1)
  const proof=(await pool.query('SELECT application_memory_history_status($1,id,scope_version::text) AS value FROM memories WHERE workspace_id=$1 AND id=$2',[workspaceId,row.id])).rows[0].value
  expect(proof.independentNodes).toContainEqual({kind:'application_field',id:own[0].id,version:own[0].version})
  expect(proof.independentNodes).toContainEqual({kind:'memory',id:row.id,version:row.scopeVersion})
  expect(proof.ownFields.some((source:{id:string;version:string})=>source.id===own[0].id&&source.version===own[0].version)).toBe(false)
  expect(proof.qualifiedAnchors).not.toContainEqual({kind:'memory',id:row.id,version:row.scopeVersion})
  expect((await state(parent.id)).scope_held).toBe(true)
  await expect(history(row.id)).rejects.toThrow()
 })
 it('retains actual Page principal checks in a mixed history caller and delivery continuation',async()=>{
  const row=await createMemory({assistantId,userId,summary:'Fictional Page mixed history',sensitivity:'internal',createdByUserId:userId})
  expect((await retractUsingTool(row.id)).isError).not.toBe(true)
  const roots=boundScopeSources(await history(row.id)),space=crypto.randomUUID()
  await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Fictional history Page space',$3)",[space,workspaceId,userId])
  await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,userId])
  const page=await createDbSavedViewStore().createDraft({userId,workspaceId,name:'Fictional history Page',entity:'tasks',viewType:'table',binding:{entity:'tasks',viewType:'table'},page:{blocks:[]},teamspaceId:space,state:'saved'},
   {provenance:{kind:'human-authored',actorId:userId}})
  const revision=(await pool.query('SELECT page_event_revision FROM saved_views WHERE id=$1',[page.id])).rows[0].page_event_revision
  const boundaries=(await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[workspaceId,revision,userId])).rows[0].authority.boundaries
  const source=boundaries.find((boundary:{role:string})=>boundary.role==='changed').savedSource
  expect(source.userId).toBeNull()
  const evidence={sources:[...roots,source]},host=await authority()
  await expect(readRetainedContextFrame(host,[],async client=>{
   await validateCallerScopeEvidence(evidence,host.execution.security.ceiling,client)
   await validateAudienceScopeEvidence(evidence,host.execution.security.ceiling,client)
   return true
  })).resolves.toBe(true)
  await pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[space,userId])
  for(const validate of [validateCallerScopeEvidence,validateAudienceScopeEvidence]){
   const current=await authority()
   await expect(readRetainedContextFrame(current,[],client=>validate(evidence,current.execution.security.ceiling,client))).rejects.toThrow()
  }
 })
 it('enforces current private assistant Team and Project recipient ceilings on genuine history bindings',async()=>{
  assistantId=crypto.randomUUID()
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fictional partitioned history assistant','standard','confidential')",[assistantId,workspaceId,userId])
  await switchActor(userId)
  const team=await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'Fictional history team',key:'fictional-history-team'})
  const project=await createDbContextScopeStore().createProject(userId,workspaceId,{name:'Fictional history project'})
  const row=await createMemory({assistantId,userId,summary:'Fictional partitioned past value',sensitivity:'confidential',compartments:[team.compartmentKey!],projectIds:[project.id],createdByUserId:userId})
  expect((await retractUsingTool(row.id)).isError).not.toBe(true)
  const roots=boundScopeSources(await history(row.id)),host=await authority(),ceiling=host.execution.security.ceiling
  expect(roots[0]).toMatchObject({userId,assistantId,compartments:[team.compartmentKey],projectIds:[project.id]})
  await expect(readRetainedContextFrame(host,[],async client=>{
   for(const validate of [validateCallerScopeEvidence,validateAudienceScopeEvidence]){
    await validate({sources:roots},ceiling,client)
    for(const[diagnostic,narrow]of [
     ['user_visibility',{...ceiling,userId:fixture.secondId}],
     ['assistant_visibility',{...ceiling,visibilityAssistantIds:[]}],
     ['teams',{...ceiling,compartments:[],departmentRead:undefined}],
     ['projects',{...ceiling,projectIds:[]}],
    ] as Array<[string,AccessCeiling]>)await expect(validate({sources:roots},narrow,client)).rejects.toMatchObject({diagnostic})
   }
   return true
  })).resolves.toBe(true)
 })
 it('keeps the existing genuine source-only successor raw anchor without inventing an own field observation',async()=>{
  const prior=await legacyCreate({assistantId,userId,workspaceId,summary:'Fictional raw-anchor predecessor',sensitivity:'internal',createdByUserId:userId})
  const current=await authority(),source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[workspaceId,prior.id])).rows[0].source
  current.accumulator.note({sources:[source]})
  const fingerprint=createHash('sha256').update(JSON.stringify({identity:current.execution.identity,ceiling:current.execution.security.ceiling,ownership:current.execution.ownership})).digest('hex')
  const next=await writeRetainedContextFrame(current,[source],client=>legacyUpdate(prior.id,
   {detail:'Fictional raw-anchor successor detail',derivation:{producer:'fixture:source-only-history',sources:[source]}},current.execution.security.access,client,
   {expectedVersion:source.version,writeFields:['detail'],assistantId,sessionId:current.execution.lifecycle.sessionId,contextFingerprint:fingerprint}))
  expect(next).not.toBeNull()
  const edges=(await pool.query("SELECT e.source_kind,e.source_id,e.source_version FROM scope_derivations d JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2 ORDER BY e.source_kind,e.source_id",[workspaceId,next!.id])).rows
  expect(edges).toEqual([{source_kind:'memory',source_id:prior.id,source_version:source.version}])
  const proof=(await pool.query('SELECT application_memory_history_status($1,id,scope_version::text) AS value FROM memories WHERE workspace_id=$1 AND id=$2',[workspaceId,prior.id])).rows[0].value
  expect(proof.ownFields).toEqual([]);expect(proof.qualifiedAnchors).toContainEqual({kind:'memory',id:prior.id,version:source.version})
  const result=await history(prior.id)
  expect(result.chain.map(version=>version.id)).toEqual([prior.id,next!.id]);expect(result.chain[1].detail).toBe('Fictional raw-anchor successor detail')
 })
 it('keeps a hidden private reason floor when the actual history root has no private-user boundary',async()=>{
  const author=await authority()
  const target=await writeRetainedContextFrame(author,[],client=>legacyCreate({assistantId,userId:null,workspaceId,summary:'Fictional shared correction target',sensitivity:'internal',createdByUserId:userId},undefined,client))
  expect(target.userId).toBeNull()
  const reason=await createMemory({assistantId,userId,summary:'Fictional private correction reason',sensitivity:'internal',createdByUserId:userId})
  const correction=await authority(),input=await memoryStore.getById(correction.execution.security.access,reason.id,correction)
  correction.accumulator.note({sources:boundScopeSources(input!)})
  expect((await retractUsingTool(target.id,correction)).isError).not.toBe(true)
  const captured=await history(target.id),ids=(await pool.query("SELECT id FROM application_field_resources WHERE workspace_id=$1 AND resource_id=$2 AND selection='history'",[workspaceId,target.id])).rows.map(row=>row.id)
  const roots=boundScopeSources(captured).filter(source=>source.resourceKind==='application_field'&&ids.includes(source.resourceId))
  expect(roots).toHaveLength(1);expect(roots[0].userId).toBeNull();expect(roots[0].assistantId).toBe(target.assistantId)
  const host=await authority()
  await expect(readRetainedContextFrame(host,[],async client=>{
   const metadata=(await client.query('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',[workspaceId,roots.map(source=>source.resourceKind),roots.map(source=>source.resourceId),roots.map(source=>source.version)])).rows[0].value
   expect(metadata).toMatchObject({purpose:'memory_history',available:true})
   expect(metadata.scopes).toEqual(expect.arrayContaining([expect.objectContaining({userId})]))
   await validateCallerScopeEvidence({sources:roots},host.execution.security.ceiling,client)
   await validateAudienceScopeEvidence({sources:roots},host.execution.security.ceiling,client)
   await expect(validateAudienceScopeEvidence({sources:roots},{...host.execution.security.ceiling,userId:fixture.secondId},client)).rejects.toMatchObject({diagnostic:'user_visibility'})
   return true
  })).resolves.toBe(true)
 })
})
