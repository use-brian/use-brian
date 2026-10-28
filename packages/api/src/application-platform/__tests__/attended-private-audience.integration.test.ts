import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator,boundScopeSources,executionToolContext,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {createMemory} from '../../db/memories.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {createAttendedDeliveryAudienceAuthorizer,validateAttendedAudienceEvidence} from '../../context-scope/attended-audience.js'
import {createDeliveryAudienceAuthorizer} from '../../context-scope/delivery-authority.js'
import {classifyAttendedSessionMessage,readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const{assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] [COMP:api/delivery-authority] current private browser conjunction',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){fixture=await persistentContextFixture();return fixture}
 async function sharedAssistant(f:Fixture){
  const existing=(await f.pool.query<{id:string}>("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='standard'",[f.workspaceId])).rows[0]
  if(existing)return existing.id
  const id=crypto.randomUUID()
  await f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional shared audience assistant',$2,$3,'standard','internal')",[id,f.ownerId,f.workspaceId])
  return id
 }
 async function sourceMemory(f:Fixture,summary:string,userId:string|null=null){
  return createMemory({workspaceId:f.workspaceId,userId,assistantId:await sharedAssistant(f),summary,sensitivity:'internal',createdByUserId:f.ownerId})
 }
 async function context(f:Fixture,actor=f.firstId,memoryId?:string){
  // Both actual members use the same real workspace assistant. Its internal
  // creation floor fits both, while each reader retains their own clearance.
  const assistantId=await sharedAssistant(f)
  const auth=await authSessionStore.create(actor,{deviceLabel:'Fictional native audience device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual authentication session')
  const session=await createPersonalWebSession({assistantId,userId:actor,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:actor,authSessionId:auth.id,authVersion:auth.authVersion})
  const claims=Object.freeze({userId:actor,sessionId:auth.id,authVersion:auth.authVersion})
  const execution=(await resolveExecutionContextSystem({userId:actor,workspaceId:f.workspaceId,assistant:(await findAssistantById(assistantId))!,
   memberMode:'member',sharedAudience:false,session,sessionAuthority:session,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
   credentialCurrent:()=>authSessionStore.validateAccess(claims)})).executionContext
  const authority={execution,accumulator:new ContextScopeAccumulator()}
  await readAdmittedSessionQuery({sessionId:session.id,throughSequence:0,authority})
  if(memoryId){const row=await createDbMemoryStore().getById(execution.security.access,memoryId);expect(row).not.toBeNull();authority.accumulator.note({sources:boundScopeSources(row!)})}
  const input={workspaceId:f.workspaceId,assistantId,userId:actor,sessionId:session.id,channelType:'web',channelId:session.channelId,
   recipientType:'individual' as const,recipientMode:'member' as const,scopeEvidence:authority.accumulator.evidence}
  return{execution,authority,session,auth,input,authorize:createAttendedDeliveryAudienceAuthorizer(execution)}
 }
 it('matches both original private sink and recipient checks using the actual original member and device',async()=>{
  const f=await setup(),memory=await sourceMemory(f,'Fictional private browser source',f.firstId),current=await context(f,f.firstId,memory.id)
  const original=createDeliveryAudienceAuthorizer({validateEvidence:(evidence,recipient)=>validateAttendedAudienceEvidence(current.execution,evidence,recipient,{directHumanSource:true})})
  const before=structuredClone(current.input),actual=await current.authorize(current.input),expected=await original(current.input)
  expect(actual).toEqual(expected);expect(actual.allowed).toBe(true);expect(current.input).toEqual(before)
 })
 it('keeps a private reply authorized after a timed-out classifier finishes unwinding',async()=>{
  const f=await setup(),current=await context(f)
  const message=await addSessionMessage({sessionId:current.session.id,role:'user',content:[{type:'text',text:'Hello'}],senderUserId:f.firstId,
   scope:{workspaceId:f.workspaceId,userId:f.firstId,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]}})
  let releaseTransport!:()=>void
  const transport=new Promise<void>(resolve=>{releaseTransport=resolve})
  const provider:LLMProvider={name:'fictional-delayed-classifier',models:['fixture'],createSession(){throw new Error('Unexpected fixture session')},
   async *stream(request){await transport;throw request.signal?.reason??new Error('Fictional delayed cancellation')}}
  try{
   const result=await classifyAttendedSessionMessage({authority:current.authority,session:current.session,message,provider,model:'fixture'})
   expect(result.classification).toMatchObject({topic_label:'(uncategorized)',confidence:0})
   const history=await readAttendedSessionHistory(current.authority,current.session.id)
   current.authority.accumulator.note({sources:boundScopeSources(history)})
   releaseTransport()
   await new Promise(resolve=>setImmediate(resolve))
   await assertSourceModelInputAuthority({...executionToolContext(current.execution,{appId:'fictional-private-reply'}),scopeAccumulator:current.authority.accumulator})
   expect(await current.authorize({...current.input,scopeEvidence:current.authority.accumulator.evidence})).toMatchObject({allowed:true})
  }finally{releaseTransport()}
 })
 it('holds a contracted source while keeping an independently authorized current browser usable',async()=>{
  const f=await setup(),memory=await sourceMemory(f,'Fictional contracting browser source'),current=await context(f,f.firstId,memory.id)
  expect(await current.authorize(current.input)).toMatchObject({allowed:true})
  await f.pool.query('UPDATE memories SET user_id=$2 WHERE id=$1',[memory.id,f.secondId])
  expect(await current.authorize(current.input)).toMatchObject({allowed:false})
  const independent=await context(f,f.secondId,memory.id)
  expect(await independent.authorize(independent.input)).toMatchObject({allowed:true})
 })
 it('retains original evidence and identity before any await and refuses a revoked original device',async()=>{
  const f=await setup(),memory=await sourceMemory(f,'Fictional immutable recipient input'),current=await context(f,f.firstId,memory.id)
  await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
  const pending=current.authorize(current.input)
  current.input.scopeEvidence.sources=[];current.input.userId=f.secondId;current.input.channelId='fictional-retargeted-channel'
  expect(await pending).toMatchObject({allowed:false})
  const device=await context(f,f.firstId)
  expect(await device.authorize(device.input)).toMatchObject({allowed:true})
  expect(await authSessionStore.revokeForUser(f.firstId,device.auth.id)).toBe(true)
  expect(await device.authorize(device.input)).toMatchObject({allowed:false})
  const independent=await context(f,f.firstId)
  expect(await independent.authorize(independent.input)).toMatchObject({allowed:true})
 })
 it('keeps a shared session on the original audience path and refuses private source evidence',async()=>{
  const f=await setup(),memory=await sourceMemory(f,'Fictional private sink source',f.firstId),current=await context(f,f.firstId,memory.id)
  const execution=await f.execution(f.firstId),authorize=createAttendedDeliveryAudienceAuthorizer(execution)
  const input={...current.input,sessionId:f.session.id,channelType:f.session.channelType,channelId:f.session.channelId}
  expect(await authorize(input)).toMatchObject({allowed:false})
 })
})
