import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type ExecutionContext,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual native-only evidence statement',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function frame<T>(execution:ExecutionContext,owner:boolean,read:(db:import('pg').PoolClient)=>Promise<T>){
  const db=await(owner?getPool():getAppPool()).connect()
  try{return await runWithAgentAccess(execution.security.access,async()=>{await db.query('BEGIN');await applyRLSGucs(db,execution.security.access.userId);return read(db)})}
  finally{await rollbackAndRelease(db)}
 }
 function rpc(execution:ExecutionContext,sources:readonly ScopeSource[],owner=false){return frame(execution,owner,async db=>(await db.query<{value:{admitted:boolean;immutable:ScopeSource[];current:ScopeSource[]}|null}>(
  'SELECT read_native_session_evidence($1,$2,$3,$4) AS value',[execution.security.access.workspaceId,sources.map(root=>root.resourceKind),sources.map(root=>root.resourceId),sources.map(root=>root.version)])).rows[0].value)}
 async function prepared(userId?:Awaited<ReturnType<typeof persistentContextFixture>>['ownerId']){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(userId??f.ownerId)
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  return{f,authority,sources:boundScopeSources(query),history}
 }
 it('admits the actual non-owner original query while the owner cannot mint a field admission',async()=>{
  const {f,authority,sources}=await prepared(),before=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  const result=await rpc(authority.execution,sources)
  expect(result?.admitted).toBe(true);expect(result?.immutable.filter(root=>root.resourceKind==='application_field').map(root=>[root.resourceId,root.version]).sort()).toEqual(sources.map(root=>[root.resourceId,root.version]).sort())
  expect(await rpc(authority.execution,sources,true)).toBeNull()
  await expect(frame(authority.execution,true,db=>validateCallerScopeEvidence({sources},authority.execution.security.ceiling,db))).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
  expect((await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows).toEqual(before)
 })
 it('rechecks SQL member contraction and leaves the independent current reader usable',async()=>{
  const {f,sources}=await prepared(),first=await f.execution(f.firstId),second=await f.execution(f.secondId)
  expect((await rpc(first,sources))?.admitted).toBe(true)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  expect(await rpc(first,sources)).toEqual({admitted:false})
  expect((await rpc(second,sources))?.admitted).toBe(true)
 })
 it('holds changed original query points and admits a fresh capture without rewriting original observations',async()=>{
  const {f,authority,sources,history}=await prepared(),before=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[history[0].id,JSON.stringify([{type:'text',text:'Fictional changed current field'}])])
  expect(await rpc(authority.execution,sources)).toEqual({admitted:false})
  const current=await f.modelContext(),fresh=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority:current})
  expect((await rpc(current.execution,boundScopeSources(fresh)))?.admitted).toBe(true)
  expect((await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows.filter(row=>before.some(original=>original.resource_id===row.resource_id&&original.version===row.version))).toEqual(before)
 })
 it('delegates generic fields without acquiring a native workspace lock',async()=>{
  fixture=await persistentContextFixture();const f=fixture,store=createDbDocEntityStore({actorUserId:f.ownerId})
  const schema=await store.createEntityType({workspaceId:f.workspaceId,name:'Fictional generic lock records',createdBy:f.ownerId,properties:[{name:'title',config:{kind:'text'}}]})
  const row=await store.createEntity({workspaceId:f.workspaceId,entityTypeId:schema.id,createdBy:f.ownerId,lastEditedBy:f.ownerId,sourceApp:'api',data:{title:{kind:'text',value:'Fictional current field'}}})
  const execution=await f.execution(),sources=await frame(execution,false,async db=>(await db.query<{value:{sources:ScopeSource[]}}>(
   'SELECT read_generic_application_record($1,$2,$3,$4) AS value',[f.workspaceId,schema.id,'record.'+schema.id,row.id])).rows[0].value.sources)
  expect(sources.length).toBeGreaterThan(0)
  await frame(execution,false,async db=>{
   const value=(await db.query<{value:unknown}>('SELECT read_native_session_evidence($1,$2,$3,$4) AS value',
    [f.workspaceId,sources.map(source=>source.resourceKind),sources.map(source=>source.resourceId),sources.map(source=>source.version)])).rows[0].value
   expect(value).toBeNull()
   const probe=await getPool().connect()
   try{await probe.query('BEGIN');expect((await probe.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT',[f.workspaceId])).rowCount).toBe(1)}
   finally{await rollbackAndRelease(probe)}
  })
 })
 it('delegates an actual mixed native memory/field closure to the unchanged validator',async()=>{
  const {f,authority,sources}=await prepared(),memory=await f.memory('Fictional mixed evidence record'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  expect(row).toBeTruthy();const all=[...sources,...boundScopeSources(row!)]
  expect(all.some(root=>root.resourceKind==='memory')).toBe(true);expect(await rpc(authority.execution,all)).toBeNull()
  expect(await frame(authority.execution,false,db=>validateCallerScopeEvidence({sources:all},authority.execution.security.ceiling,db))).toMatchObject({sources:expect.any(Array)})
 })
})
