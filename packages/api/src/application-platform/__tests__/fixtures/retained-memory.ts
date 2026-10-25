import {ContextScopeAccumulator,boundScopeSources,createMemoryTools,executionToolContext,type ToolContext} from '@use-brian/core'
import {expect} from 'vitest'
import {createDbMemoryStore} from '../../../db/memory-store.js'
import {authSessionStore} from '../../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession} from '../../../db/sessions.js'
import {findAssistantById} from '../../../db/users.js'
import {resolveExecutionContextSystem} from '../../../context-scope/execution-context.js'
import {sessionMessageInputScope} from '../../../context-scope/resolve-turn-scope.js'
import {bindSessionContextRetainedAuthority} from '../../../db/session-context-revisions.js'
import {readAdmittedSessionQuery} from '../../../db/session-query-reader.js'
import type {ScopeSource} from '@use-brian/core'
import {sourceModeFixture} from './source-modes.js'
const store=createDbMemoryStore(),tools=createMemoryTools(store)
 export async function originalMemoryAuthority(x:Awaited<ReturnType<typeof sourceModeFixture>>,actor=x.f.ownerId,shared=false){
  const auth=await authSessionStore.create(actor,{deviceLabel:'Fictional memory device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual memory authentication session')
  const session=await createPersonalWebSession({assistantId:x.f.assistantId,userId:actor,workspaceId:x.f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:actor,authSessionId:auth.id,authVersion:auth.authVersion})
  const claims=Object.freeze({userId:actor,sessionId:auth.id,authVersion:auth.authVersion}),assistant=await findAssistantById(x.f.assistantId)
  if(!assistant)throw new Error('Missing actual memory assistant')
  const resolved=await resolveExecutionContextSystem({userId:actor,workspaceId:x.f.workspaceId,assistant,memberMode:'member',sharedAudience:false,session,sessionAuthority:session,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:x.f.workspaceId},
   lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
   credentialCurrent:async()=>!!await authSessionStore.validateAccess(claims)})
  const execution=resolved.executionContext
  const current=await x.runtime(actor,shared?undefined:execution)
  bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>x.coordinator.prepare(execution,sources,action))
  return{...current,session:shared?x.f.session:session,turnScope:resolved.turnScope,context:{...executionToolContext(current.execution,{appId:'fictional-memory-tool'}),scopeAccumulator:current.accumulator} as ToolContext}
 }
 export async function saveOriginalMemory(x:Awaited<ReturnType<typeof sourceModeFixture>>,mode:'governed'|'released_snapshot'='governed',retainSessionFields=true){
  const current=await originalMemoryAuthority(x),input={id:'record-1',fields:['description'],...(mode==='released_snapshot'?{retentionMode:mode,releaseId:x.releaseId}:{})}
  const read=await current.runtime.read!('readRecord',input,mode)
  let fieldRoots:ScopeSource[]=[]
  if(retainSessionFields){
   const message=await addSessionMessage({sessionId:current.session.id,role:'user',content:[{type:'text',text:'Fictional original private request'}],scope:sessionMessageInputScope({scope:current.turnScope,workspaceId:x.f.workspaceId,userId:x.f.ownerId})})
   const query=await readAdmittedSessionQuery({sessionId:current.session.id,throughSequence:message.sequenceNum,authority:current})
   fieldRoots=boundScopeSources(query);current.accumulator.note({sources:fieldRoots})
  }
  const native=await x.f.memory('Fictional independent native input'),source=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,native.id])).rows[0].source as ScopeSource
  current.accumulator.note({sources:[source]})
  const result=await tools.saveMemory.execute({summary:'Fictional source-backed memory tool result',detail:'Fictional preserved mixed ancestry',scope:'team'},current.context)
  expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const id=String(result.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(id,JSON.stringify(result)).toBeTruthy()
  return{current,id:id!,read,fieldRoots,nativeSource:source}
 }
 export async function readOriginalMemory(x:Awaited<ReturnType<typeof sourceModeFixture>>,id:string,actor=x.f.ownerId){
  const current=await originalMemoryAuthority(x,actor)
  return tools.getMemory.execute({id},current.context)
 }
