import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext,type ScopeSource,type ExecutionContext} from '@use-brian/core'
import {getAppPool,getPool,runWithAgentAccess,applyRLSGucs,rollbackAndRelease} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual native memory and session evidence',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function frame<T>(execution:ExecutionContext,read:(db:import('pg').PoolClient)=>Promise<T>){
  const db=await getAppPool().connect()
  try{return await runWithAgentAccess(execution.security.access,async()=>{await db.query('BEGIN');await applyRLSGucs(db,execution.security.access.userId);return read(db)})}
  finally{await rollbackAndRelease(db)}
 }
 function rpc(execution:ExecutionContext,sources:readonly ScopeSource[],legacy=false){return frame(execution,async db=>(await db.query<{value:{admitted:boolean;immutable:ScopeSource[];current:ScopeSource[]}|null}>(
  legacy?'SELECT read_native_session_evidence($1,$2,$3,$4) AS value':'SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',
  [execution.security.access.workspaceId,sources.map(root=>root.resourceKind),sources.map(root=>root.resourceId),sources.map(root=>root.version)])).rows[0].value)}
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const memory=await f.memory('Fictional shared native memory'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  if(!row)throw new Error('Missing actual readable memory')
  const sources=[...boundScopeSources(query),...boundScopeSources(row)]
  authority.accumulator.note({sources})
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  return{f,authority,memory,sources,context}
 }
 it('admits real mixed native evidence while preserving the original RPC fallback contract',async()=>{
  const {authority,sources,context}=await setup()
  expect(await rpc(authority.execution,sources,true)).toBeNull()
  const value=await rpc(authority.execution,sources)
  expect(value?.admitted).toBe(true);expect(value?.current.some(source=>source.resourceKind==='memory')).toBe(true)
  await expect(frame(authority.execution,db=>validateCallerScopeEvidence({sources},authority.execution.security.ceiling,db))).resolves.toMatchObject({sources:expect.any(Array)})
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  await expect(assertSourceModelOutputAuthority(context)).resolves.toBeUndefined()
 })
 it('holds reclassified memory for the original reader and keeps another authorized reader usable',async()=>{
  const {f,authority,memory,sources,context}=await setup(),before=structuredClone(sources)
  const writer=await getPool().connect();let pending:ReturnType<typeof rpc>|undefined
  try{
   await writer.query('BEGIN')
   await writer.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id])
   pending=rpc(authority.execution,sources)
   // An actual other transaction owns the current row. Optional NOWAIT reuse
   // must retain the canonical wait and cannot publish the former scope.
   await expect.poll(async()=>(await f.pool.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
    WHERE usename='app_user' AND datname=current_database() AND query LIKE '%read_native_attended_memory_evidence%'
     AND cardinality(pg_blocking_pids(pid))>0) AS blocked`)).rows[0].blocked,{timeout:2000}).toBe(true)
   await writer.query('COMMIT')
   expect(await pending).toEqual({admitted:false})
  }finally{await rollbackAndRelease(writer);await pending?.catch(()=>{})}
  await f.pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id])
  expect(await rpc(authority.execution,sources)).toEqual({admitted:false})
  await expect(assertSourceModelInputAuthority(context)).rejects.toMatchObject({reason:'authority_changed'})
  const second=await f.execution(f.secondId)
  expect((await rpc(second,sources))?.admitted).toBe(true)
  expect(sources).toEqual(before)
 })
 it('rejects another member private memory even when the session query is readable',async()=>{
  const {f,authority,sources}=await setup(),memory=await f.memory('Fictional private native memory',f.secondId)
  const auth=await authSessionStore.create(f.secondId,{deviceLabel:'Fictional private memory fixture',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual private authentication')
  const personal=await createPersonalWebSession({assistantId:f.assistantId,userId:f.secondId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.secondId,authSessionId:auth.id,authVersion:auth.authVersion})
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual assistant')
  const second=(await resolveExecutionContextSystem({userId:f.secondId,workspaceId:f.workspaceId,assistant,session:personal,sessionAuthority:personal,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.secondId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:f.workspaceId},
   lifecycle:{sessionId:personal.id,channelId:personal.channelId,channelType:'web',abortSignal:new AbortController().signal}})).executionContext
  const row=await createDbMemoryStore().getById(second.security.access,memory.id)
  if(!row)throw new Error('Missing actual private memory')
  const mixed=[...sources,...boundScopeSources(row)]
  expect(await rpc(authority.execution,mixed)).toEqual({admitted:false})
  expect((await rpc(second,mixed))?.admitted).toBe(true)
 })
 it('keeps native D1 disappearance without erasing the original memory observation',async()=>{
  const {f,authority,memory,sources,context}=await setup(),before=structuredClone(sources)
  await f.pool.query('DELETE FROM memories WHERE id=$1',[memory.id])
  expect((await rpc(authority.execution,sources))?.admitted).toBe(true)
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  expect(sources).toEqual(before)
 })
 it('rejects owner-role admission and follows canonical query evaluator drift',async()=>{
  const {f,authority,memory,sources}=await setup(),db=await getPool().connect()
  const privateHelpers=['application_memory_query_candidate_state(uuid,uuid,text[],jsonb)',
   'application_memory_statement_state(uuid,uuid,text[],jsonb)','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)',
   'application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)',
   'application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])',
   'application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])',
   'application_memory_statement_helpers_current()','application_session_eval_field(uuid,uuid,text,jsonb)',
   'application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)',
   'read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)']
  expect((await getAppPool().query(`SELECT count(*)::integer AS count,
   bool_or(has_function_privilege(current_user,p.oid,'EXECUTE')) AS callable,
   bool_or(EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')) AS public_execute,
   bool_and(p.proowner=(SELECT proowner FROM pg_proc WHERE oid='application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure)) AS canonical_owner
   FROM unnest($1::text[]) signature JOIN pg_proc p ON p.oid=signature::regprocedure`,[privateHelpers])).rows).toEqual([{count:12,callable:false,public_execute:false,canonical_owner:true}])
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   expect((await db.query<{value:unknown}>('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',
    [f.workspaceId,sources.map(source=>source.resourceKind),sources.map(source=>source.resourceId),sources.map(source=>source.version)])).rows[0].value).toBeNull()
  })}finally{await rollbackAndRelease(db)}
  const definition=(await f.pool.query<{definition:string;metadata:unknown}>(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
   WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure`)).rows[0]
  const query=()=>frame(authority.execution,async client=>(await client.query<{value:{row:{id:string;summary:string}|null}}>(
   'SELECT value FROM read_native_memory_query_projection($1,$2,false)',[f.workspaceId,['id','summary']])).rows.map(row=>row.value))
  expect((await query()).some(value=>value.row?.id===memory.id&&value.row.summary==='Fictional shared native memory')).toBe(true)
  // Synthetic future canonical drift must use its live per-row reader, never
  // the old cloned candidate. No application privilege or evaluator is weakened.
  const changed=definition.definition.replace('\nBEGIN\n','\nBEGIN\n RETURN NULL;\n')
  expect(changed).not.toBe(definition.definition)
  try{
   await f.pool.query(changed)
   expect((await f.pool.query(`SELECT to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
    WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure`)).rows[0].metadata).toEqual(definition.metadata)
   expect((await query()).map(value=>value.row)).toEqual([null])
  }finally{await f.pool.query(definition.definition)}
  expect((await f.pool.query(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
   WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure`)).rows[0]).toEqual(definition)
  expect((await query()).some(value=>value.row?.id===memory.id&&value.row.summary==='Fictional shared native memory')).toBe(true)
  // The statement visitor must also follow drift in the complete canonical
  // envelope chain. Its current private clone cannot substitute an older body.
  const envelope=(await f.pool.query<{definition:string;metadata:unknown}>(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
   WHERE oid='public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure`)).rows[0]
  const protectedMemory=await createDbMemoryStore().getById(authority.execution.security.access,memory.id,authority)
  if(!protectedMemory)throw new Error('Missing actual authority-bound Memory projection')
  expect(boundScopeSources(protectedMemory).some(source=>source.resourceKind==='application_field')).toBe(true)
  const protectedSources=[...sources,...boundScopeSources(protectedMemory)]
  const helpersBefore=(await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current
  expect((await rpc(authority.execution,protectedSources))?.admitted).toBe(true)
  const changedEnvelope=envelope.definition.replace('\nBEGIN\n','\nBEGIN\n RETURN NULL;\n')
  expect(changedEnvelope).not.toBe(envelope.definition)
  try{
   await f.pool.query(changedEnvelope)
   expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(false)
   expect(await rpc(authority.execution,protectedSources)).toEqual({admitted:false})
  }finally{await f.pool.query(envelope.definition)}
  expect((await f.pool.query(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
   WHERE oid='public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure`)).rows[0]).toEqual(envelope)
  expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(helpersBefore)
  expect((await rpc(authority.execution,protectedSources))?.admitted).toBe(true)
  // Both exact dispatcher deltas remain pinned after reconciliation. A future
  // canonical body change must still use its current path and deny this row.
  for(const signature of ['application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])',
   'application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])',
   'read_entity_derivation_source(uuid,text,uuid)']){
   const dispatcher=(await f.pool.query<{definition:string;metadata:unknown}>(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
    WHERE oid=$1::regprocedure`,[signature])).rows[0]
   const changedDispatcher=dispatcher.definition.replace('\nBEGIN\n','\nBEGIN\n RETURN NULL;\n')
   expect(changedDispatcher).not.toBe(dispatcher.definition)
   try{
    await f.pool.query(changedDispatcher)
    expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(false)
    expect(await rpc(authority.execution,protectedSources)).toEqual({admitted:false})
   }finally{await f.pool.query(dispatcher.definition)}
   expect((await f.pool.query(`SELECT pg_get_functiondef(oid) AS definition,to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
    WHERE oid=$1::regprocedure`,[signature])).rows[0]).toEqual(dispatcher)
   expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(true)
   expect((await rpc(authority.execution,protectedSources))?.admitted).toBe(true)
  }
  // Name normalization applies only to the exact reviewed predecessor name.
  // A later unknown rename at the same OID cannot inherit the original pin.
  let predecessorRenamed=false
  try{
   await f.pool.query('ALTER FUNCTION application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_unreviewed');predecessorRenamed=true
   expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(false)
  }finally{if(predecessorRenamed)await f.pool.query('ALTER FUNCTION application_field_projection_state_unreviewed(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_feedback_outcome')}
  expect((await f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(true)
  // Keep the intended known-helper positive profile explicit. An additive
  // canonical dispatcher must receive its own reviewed compatibility amendment.
  expect(helpersBefore).toBe(true)
 })
 it('keeps generic fields on the original path without taking a native workspace lock',async()=>{
  fixture=await persistentContextFixture();const f=fixture,store=createDbDocEntityStore({actorUserId:f.ownerId})
  const schema=await store.createEntityType({workspaceId:f.workspaceId,name:'Fictional mixed generic records',createdBy:f.ownerId,properties:[{name:'title',config:{kind:'text'}}]})
  const row=await store.createEntity({workspaceId:f.workspaceId,entityTypeId:schema.id,createdBy:f.ownerId,lastEditedBy:f.ownerId,sourceApp:'api',data:{title:{kind:'text',value:'Fictional generic value'}}})
  const execution=await f.execution(),memory=await f.memory('Fictional shared memory for generic fallback')
  const native=await createDbMemoryStore().getById(execution.security.access,memory.id)
  if(!native)throw new Error('Missing actual shared memory')
  const fields=await frame(execution,async db=>(await db.query<{value:{sources:ScopeSource[]}}>('SELECT read_generic_application_record($1,$2,$3,$4) AS value',
   [f.workspaceId,schema.id,'record.'+schema.id,row.id])).rows[0].value.sources)
  const mixed=[...fields,...boundScopeSources(native)]
  await frame(execution,async db=>{
   expect((await db.query<{value:unknown}>('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',
    [f.workspaceId,mixed.map(root=>root.resourceKind),mixed.map(root=>root.resourceId),mixed.map(root=>root.version)])).rows[0].value).toBeNull()
   const probe=await getPool().connect()
   try{await probe.query('BEGIN');expect((await probe.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT',[f.workspaceId])).rowCount).toBe(1)}
   finally{await rollbackAndRelease(probe)}
  })
 })
 it('keeps independently sourced native content on the fresh source-authority path',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture,history=await f.history(),authority=await f.modelContext()
  independent=await persistentSourceFixture(f)
  const carrier=await independent.writeTranscript(),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const memory=await f.memory('Fictional shared memory with source fallback'),native=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  if(!native)throw new Error('Missing actual shared memory')
  expect(await rpc(authority.execution,[...boundScopeSources(query),...boundScopeSources(native),...boundScopeSources(carrier)])).toBeNull()
 })
})
