import {ContextScopeAccumulator,executionToolContext,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,runWithAgentAccess} from '../../../db/client.js'
import {createDbKnowledgeStore} from '../../../db/knowledge-store.js'
import {recordDerivedResource,validateDerivedEntityInputs} from '../../../db/derived-scope-store.js'
import {bindSessionContextRetainedAuthority} from '../../../db/session-context-revisions.js'
import {pinPreparedExternalSourceAuthority} from '../../retained-source-authority.js'
import {authSessionStore} from '../../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../../db/sessions.js'
import {findAssistantById} from '../../../db/users.js'
import {resolveExecutionContextSystem} from '../../../context-scope/execution-context.js'
import {persistentContextFixture} from './persistent-context.js'
import {persistentSourceFixture} from './persistent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const store=createDbKnowledgeStore()
/** Actual canonical retained Knowledge with an independent source and original native contexts. */
export async function retainedKnowledgeFixture(){
 await assertLocalFixture()
 const current=await persistentContextFixture('confidential')
 let cleanupSource:(()=>Promise<void>)|undefined
 try{
  const source=await persistentSourceFixture(current)
  cleanupSource=source.cleanup
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
  return{f:current,source,row,context,snapshot,cleanup:async()=>{try{await source.cleanup()}finally{await current.cleanup()}}}
 }catch(error){try{await cleanupSource?.()}finally{await current.cleanup()}throw error}
}
