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
 it('rejects owner-role admission for the new batch',async()=>{
  const {f,authority,sources}=await setup(),db=await getPool().connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   expect((await db.query<{value:unknown}>('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',
    [f.workspaceId,sources.map(source=>source.resourceKind),sources.map(source=>source.resourceId),sources.map(source=>source.version)])).rows[0].value).toBeNull()
  })}finally{await rollbackAndRelease(db)}
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
