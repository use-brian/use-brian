import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator,boundScopeSources} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {sessionMessageInputScope} from '../../context-scope/resolve-turn-scope.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] current personal native query floor',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture
  const auth=await authSessionStore.create(f.secondId,{deviceLabel:'Fictional personal fixture',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual fixture authentication')
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.secondId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.secondId,authSessionId:auth.id,authVersion:auth.authVersion})
  async function current(){
   const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing fixture assistant')
   const resolved=await resolveExecutionContextSystem({userId:f.secondId,workspaceId:f.workspaceId,assistant,session,sessionAuthority:session,
    identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.secondId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:f.workspaceId},
    lifecycle:{sessionId:session.id,channelId:session.channelId,channelType:'web',abortSignal:new AbortController().signal}})
   return{resolved,authority:{execution:resolved.executionContext,accumulator:new ContextScopeAccumulator()}}
  }
  return{f,session,current}
 }
 it('reads an actual null-clearance personal session from the current assistant/member floor',async()=>{
  const {f,session,current}=await setup(),{resolved,authority}=await current()
  expect((await f.pool.query('SELECT effective_clearance FROM sessions WHERE id=$1',[session.id])).rows[0].effective_clearance).toBeNull()
  const message=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Fictional private input'}],
   scope:sessionMessageInputScope({scope:resolved.turnScope,workspaceId:f.workspaceId,userId:f.secondId})})
  const result=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,authority})
  expect(result.history.map(row=>row.id)).toEqual([message.id])
  expect(boundScopeSources(result).filter(source=>source.resourceKind==='application_field').every(source=>source.sensitivity==='confidential'&&source.userId===f.secondId)).toBe(true)
 })
 it('keeps a new lower-clearance invocation usable while holding previously confidential content',async()=>{
  const {f,session,current}=await setup(),before=await current()
  const message=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Fictional confidential input'}],
   scope:sessionMessageInputScope({scope:before.resolved.turnScope,workspaceId:f.workspaceId,userId:f.secondId})})
  const original=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,authority:before.authority})
  const observations=boundScopeSources(original)
  await f.pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.secondId])
  await expect(readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,authority:before.authority})).rejects.toMatchObject({reason:'authority_changed'})
  const after=await current(),fresh=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,authority:after.authority})
  expect(fresh.history).toEqual([])
  expect(boundScopeSources(original)).toEqual(observations)
  expect((await f.pool.query('SELECT scope_held FROM session_messages WHERE id=$1',[message.id])).rows[0].scope_held).toBe(false)
 })
})
