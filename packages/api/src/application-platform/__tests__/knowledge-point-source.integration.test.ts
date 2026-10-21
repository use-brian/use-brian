import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator,createKnowledgeTools,executionToolContext,type LLMProvider,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,runWithAgentAccess} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {recordDerivedResource,validateDerivedEntityInputs} from '../../db/derived-scope-store.js'
import {bindSessionContextRetainedAuthority} from '../../db/session-context-revisions.js'
import {pinPreparedExternalSourceAuthority} from '../retained-source-authority.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Independent=Awaited<ReturnType<typeof persistentSourceFixture>>
describe.sequential('[COMP:api/application-persistence] actual retained-source knowledge point reads',()=>{
 let f:Fixture|undefined,independent:Independent|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);await independent?.cleanup();independent=undefined;await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function fixture(){
  f=await persistentContextFixture('confidential');const current=f
  independent=await persistentSourceFixture(current);const source=independent
  const row=await store.create({workspaceId:current.workspaceId,path:'fictional-source-point',title:'Fictional retained Knowledge',
   content:'Fictional protected Knowledge bytes',sensitivity:source.root.sensitivity,compartments:[...source.root.compartments],
   projectIds:[...source.root.projectIds],createdBy:current.ownerId})
  const authority=await current.modelContext(),derivation={producer:'fixture:retained-knowledge-point',sources:[source.root]}
  const proof=await source.coordinator.prepare(authority.execution,derivation.sources,'retain'),client=await current.pool.connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,current.ownerId)
   await pinPreparedExternalSourceAuthority(client,authority.execution,proof)
   await validateDerivedEntityInputs(client,derivation)
   const output=(await client.query<{source:ScopeSource}>("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[current.workspaceId,row.id])).rows[0].source
   await recordDerivedResource(client,derivation,{...output,resourceKind:'knowledge_entry',resourceId:row.id},current.ownerId)
   await client.query('COMMIT')
  })}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  async function context(userId=current.ownerId,personal=false){
   let authority=await current.modelContext(userId)
   if(personal){
    const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional Knowledge device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    if(!auth)throw new Error('Missing actual Knowledge authentication session')
    const session=await createPersonalWebSession({assistantId:current.assistantId,userId,workspaceId:current.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
     {actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion})
    const claims=Object.freeze({userId,sessionId:auth.id,authVersion:auth.authVersion})
    const assistant=await findAssistantById(current.assistantId)
    if(!assistant)throw new Error('Missing actual Knowledge assistant')
    const execution=(await resolveExecutionContextSystem({userId,workspaceId:current.workspaceId,assistant,memberMode:'member',sharedAudience:false,
     session,sessionAuthority:session,identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},
     ownership:{kind:'workspace',workspaceId:current.workspaceId},lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
     credentialCurrent:()=>authSessionStore.validateAccess(claims)})).executionContext
    authority={execution,accumulator:new ContextScopeAccumulator()}
   }
   bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>source.coordinator.prepare(execution,sources,action))
   return{...executionToolContext(authority.execution,{appId:'fictional-knowledge-reader'}),scopeAccumulator:authority.accumulator}
  }
  const snapshot=async()=>(await current.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[current.workspaceId,row.id])).rows[0].source
  return{f:current,source,row,context,snapshot}
 }
 it('holds independently retained content at the actual ID point reader without original current source authority',async()=>{
  const c=await fixture(),context=await c.context()
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},context)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const actual=await store.getById(context.executionContext!.security.access,c.row.id)
  expect(actual).toBeNull()
 })
 it('rechecks an actual independent source grant before returning the Knowledge tool body and preserves a second reader and canonical metadata',async()=>{
  const c=await fixture(),first=await c.context(),second=await c.context(c.f.secondId)
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},first)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  expect((await tool.execute({id:c.row.id},second)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const refused=await tool.execute({id:c.row.id},first)
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused)).not.toContain('Fictional protected Knowledge bytes')
  expect((await tool.execute({id:c.row.id},second)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  expect(await c.snapshot()).toEqual(before)
 })
 for(const reader of ['legacy','original host'] as const)it(`holds a retained Knowledge successor without matching immutable observations at the actual ${reader} ID reader`,async()=>{
  const c=await fixture(),context=await c.context(),tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},context)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const original=await c.snapshot()
  await c.f.pool.query("UPDATE knowledge_entries SET title='Fictional retained Knowledge successor' WHERE id=$1",[c.row.id])
  const current=await c.snapshot()
  expect(current.version).not.toBe(original.version)
  expect((await c.f.pool.query("SELECT resource_version FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='knowledge_entry' AND resource_id=$2",[c.f.workspaceId,c.row.id])).rows).toEqual([{resource_version:original.version}])
  if(reader==='legacy')expect(await store.getById(context.executionContext!.security.access,c.row.id)).toBeNull()
  else{
   const result=await tool.execute({id:c.row.id},context)
   expect(result.isError).toBe(true)
   expect(JSON.stringify(result)).not.toContain('Fictional protected Knowledge bytes')
  }
 })

 it('holds cached actual Knowledge tool content before text extraction/provider dispatch after independent withdrawal and keeps a separate current model reader usable',async()=>{
  const c=await fixture()
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  const shared=await c.context(),sharedResult=await tool.execute({id:c.row.id},shared)
  if(!sharedResult.scopeEvidence)throw new Error('Shared Knowledge tool must retain evidence')
  shared.scopeAccumulator.note(sharedResult.scopeEvidence)
  await expect(assertSourceModelInputAuthority(shared)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  const result=await tool.execute({id:c.row.id},context)
  expect(result.data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  if(!result.scopeEvidence)throw new Error('Actual Knowledge tool output must carry canonical evidence')
  context.scopeAccumulator.note(result.scopeEvidence)
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  const before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-knowledge-source',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},
   stream:async function*(){calls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional current Knowledge title'};
    yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  const messages=[{role:'user' as const,get content(){extractions++;return JSON.stringify(result.data)}}]
  await expect(generateTitle(provider,messages,'fixture',()=>assertSourceModelInputAuthority(context))).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  expect(await c.snapshot()).toEqual(before)
  const other=await c.context(c.f.secondId,true),current=await tool.execute({id:c.row.id},other)
  expect(current.data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  if(!current.scopeEvidence)throw new Error('Independent Knowledge reader must carry canonical evidence')
  other.scopeAccumulator.note(current.scopeEvidence)
  await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current.data)}],'fixture',()=>assertSourceModelInputAuthority(other))).resolves.toEqual({title:'Fictional current Knowledge title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(calls).toBe(1)
  expect(await c.snapshot()).toEqual(before)
 })

})
