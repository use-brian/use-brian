import {runAssistantTurn} from '../../turn/kernel.js'
import {randomUUID} from 'node:crypto'
import {validateAttendedAudienceEvidence} from '../../context-scope/attended-audience.js'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,queryLoop,type QueryEvent,type LLMProvider} from '@use-brian/core'
import {captureAttendedSessionClassification,forkAttendedSessionClassification,assessAttendedSessionMessage,captureNativeClassifiedAssembly,classifyAttendedSessionMessage,classifyAttendedResearchMessage,readAttendedSessionHistory,readClassifiedSessionHistory,attendedSessionTurnCount} from '../../routes/attended-session-context.js'
import * as sessionQueries from '../../db/session-query-reader.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {createNativeAttendedOutputBoundary,assertSourceModelInputAuthority} from '../model-source-authority.js'
import {readSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {bindSessionContextRetainedAuthority,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {resolveReplyText} from '../../routes/_reply-context.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual admitted reply history',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{vi.restoreAllMocks();await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(clearance:'internal'|'confidential'='internal'){
  fixture=await persistentContextFixture(clearance);const f=fixture,rows=await f.history()
  await f.pool.query('UPDATE session_messages SET channel_message_id=$2 WHERE id=$1',[rows[1].id,'fictional-channel-reply'])
  const authority=await f.modelContext(),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:rows.at(-1)!.sequenceNum,authority})
  return{f,rows,query}
 }
 async function stagedSetup(){
  fixture=await persistentContextFixture();const f=fixture
  const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional staging browser',userAgent:null,ipAddress:null}))!
  const claims={userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion}
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  const scope={...f.envelope,userId:f.ownerId,assistantId:f.assistantId}
  const earlier=await addSessionMessage({sessionId:session.id,role:'user',content:'Fictional earlier topic request',scope})
  const message=await addSessionMessage({sessionId:session.id,role:'user',content:'Fictional current topic request',scope})
  const authority=await resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
  const capture=await captureAttendedSessionClassification({authority,session,message})
  const fork=forkAttendedSessionClassification({authority,session,message,capture})
  const measurements:string[]=[]
  const assessment=await assessAttendedSessionMessage({authority:fork.authority,session,message,capture:fork.capture,
   provider:classifierProvider(),model:'fixture',measure:async(counter,run)=>{measurements.push(counter);return run()}})
  const boundary=createNativeAttendedOutputBoundary(authority.execution,authority.accumulator,{
   workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,sessionId:session.id,
   channelType:'web',channelId:session.channelId,recipientType:'individual',
  })
  const handoff=captureNativeClassifiedAssembly(assessment,authority,boundary)
  expect(handoff).toBeDefined()
  return{f,session,scope,earlier,message,authority,assessment,boundary,handoff:handoff!,measurements,fork,claims}
 }
 it('stages immutable classifier bytes and captured history without the two repeated full proofs',async()=>{
  const c=await stagedSetup(),before=c.measurements.length
  const framed=vi.spyOn(await import('../../db/session-context-revisions.js'),'readSessionQueryFrame')
  const result=await c.handoff.defer();c.fork.mergeEvidence()
  result.history[0].content='Untrusted mutation of returned staging bytes'
  const history=await c.handoff.readHistory()
  expect(history[0].content).toBe(c.earlier.content)
  expect(boundScopeSources(history)).toEqual(boundScopeSources(result.history))
  expect(c.measurements).toHaveLength(before)
  expect(framed).not.toHaveBeenCalled()
  expect(Object.isFrozen(result.classification)).toBe(true)
  expect(result.pendingAnnotation).toBeDefined()
  expect(await readSessionMessageAnnotation(c.session.id,c.message.id,c.authority)).toBeNull()
 })
 it('keeps current selector metadata and falls back when a new physical message arrives',async()=>{
  const c=await stagedSetup();await c.handoff.defer()
  const added=await addSessionMessage({sessionId:c.session.id,role:'user',content:'Fictional later message',scope:c.scope})
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  const history=await c.handoff.readHistory()
  expect(full).toHaveBeenCalledOnce()
  expect(history.at(-1)?.id).toBe(added.id)
 })
 it('does not let private staged history authorize a held source at actual query-loop dispatch',async()=>{
  const c=await stagedSetup();await c.handoff.defer();c.fork.mergeEvidence()
  const history=await c.handoff.readHistory()
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.earlier.id])
  const stream=vi.fn<LLMProvider['stream']>(async function*(){yield{type:'text_delta',text:'Must not dispatch'}})
  const provider:LLMProvider={name:'fictional-staged-dispatch',models:['fixture'],stream,createSession(){throw new Error('Stateless fixture expected')}}
  const context={...executionToolContext(c.authority.execution,{appId:'fictional-staged-input'}),scopeAccumulator:c.authority.accumulator,
   assertModelInputAuthority:assertSourceModelInputAuthority}
  await expect((async()=>{for await(const _event of queryLoop({provider,model:'fixture',systemPrompt:'Fictional context',messages:history.map(row=>({role:row.role as 'user',content:row.content as string})),
   tools:new Map(),ledger:NOOP_TURN_LEDGER,context,stateless:true,maxTurns:1})){/* consume */}})()).rejects.toMatchObject({reason:'authority_changed'})
  expect(stream).not.toHaveBeenCalled()
 })
 it('checks each actual effect freshly and makes source refusal sticky before custom callbacks',async()=>{
  const c=await stagedSetup();await c.handoff.defer()
  const before=c.measurements.length,effect=vi.fn(async()=>7)
  expect(await c.handoff.runEffect(effect)).toBe(7)
  expect(await c.handoff.runEffect(effect)).toBe(7)
  expect(c.measurements).toHaveLength(before+2)
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.earlier.id])
  await expect(c.handoff.runEffect(effect)).rejects.toMatchObject({reason:'authority_changed'})
  const refused=c.measurements.length
  await expect(c.handoff.runEffect(effect)).rejects.toMatchObject({reason:'authority_changed'})
  expect(c.measurements).toHaveLength(refused)
  expect(effect).toHaveBeenCalledTimes(2)
 })
 it('keeps ordinary custom effect failures separate from authority refusal',async()=>{
  const c=await stagedSetup();await c.handoff.defer()
  const failure=new Error('Fictional ordinary store failure')
  await expect(c.handoff.runEffect(async()=>{throw failure})).rejects.toBe(failure)
  await expect(c.handoff.runEffect(async()=>9)).resolves.toBe(9)
 })
 it('refuses copied owners and replaced assessment methods instead of granting staging privileges',async()=>{
  const c=await stagedSetup()
  expect(captureNativeClassifiedAssembly({...c.assessment},c.authority,c.boundary)).toBeUndefined()
  expect(captureNativeClassifiedAssembly(c.assessment,c.authority,{...c.boundary})).toBeUndefined()
  c.assessment.defer=async()=>{throw new Error('Must not run replaced method')}
  expect(captureNativeClassifiedAssembly(c.assessment,c.authority,c.boundary)).toBeUndefined()
  await expect(c.handoff.defer()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it('refuses a root accumulator replaced while the staging lease is pending',async()=>{
  const c=await stagedSetup(),pending=c.handoff.defer()
  queueMicrotask(()=>{(c.authority as {accumulator:ContextScopeAccumulator}).accumulator=new ContextScopeAccumulator()})
  await expect(pending).rejects.toMatchObject({reason:'authority_changed'})
  expect(await readSessionMessageAnnotation(c.session.id,c.message.id,{...c.authority,accumulator:new ContextScopeAccumulator()})).toBeNull()
 })
 it('rejects a genuinely different root authority substituted before handoff creation',async()=>{
  const c=await stagedSetup(),replacement=await resolveSessionTitleAuthority({claims:c.claims,sessionId:c.session.id,readOnly:false})
  const root=c.authority as {execution:typeof c.authority.execution;accumulator:ContextScopeAccumulator}
  root.execution=replacement.execution;root.accumulator=replacement.accumulator
  const boundary=createNativeAttendedOutputBoundary(root.execution,root.accumulator,{
   workspaceId:c.f.workspaceId,assistantId:c.f.assistantId,userId:c.f.ownerId,sessionId:c.session.id,
   channelType:'web',channelId:c.session.channelId,recipientType:'individual',
  })
  expect(captureNativeClassifiedAssembly(c.assessment,c.authority,boundary)).toBeUndefined()
  await expect(c.handoff.defer()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it('preserves the complete admitted query evidence through a web reply snippet',async()=>{
  const {f,rows,query}=await setup()
  const reply=await resolveReplyText({session:f.session,channelType:'web',replyToMessageId:rows[1].id,clientSnippet:'Fictional selected phrase',readableHistory:query.history})
  if(!reply)throw new Error('Expected an admitted reply')
  expect(reply).toMatchObject({text:'Fictional selected phrase',messageId:rows[1].id,fromAssistant:true})
  expect(boundScopeSources(reply)).toEqual(expect.arrayContaining([...boundScopeSources(query.history)]))
 })
 it('does not recover a missing web reply from an owner read or client snippet',async()=>{
  const {f,rows}=await setup()
  expect(await resolveReplyText({session:f.session,channelType:'web',replyToMessageId:rows[1].id,clientSnippet:'Fictional unadmitted snippet',readableHistory:[]})).toBeNull()
 })
 it('does not recover a missing Telegram reply from a provider quote',async()=>{
  const {f}=await setup()
  expect(await resolveReplyText({session:f.session,channelType:'telegram',replyToMessageId:'fictional-channel-reply',readableHistory:[],
   raw:{reply_to_message:{text:'Fictional provider-only quote',from:{is_bot:true}}}})).toBeNull()
 })
 it('uses the admitted native Telegram body and its observations over provider text',async()=>{
  const {f,query}=await setup()
  const reply=await resolveReplyText({session:f.session,channelType:'telegram',replyToMessageId:'fictional-channel-reply',readableHistory:query.history,
   raw:{reply_to_message:{text:'Fictional provider-only quote',from:{is_bot:false}}}})
  if(!reply)throw new Error('Expected an admitted reply')
  expect(reply).toMatchObject({text:'Fictional earlier response',fromAssistant:true})
  expect(boundScopeSources(reply)).toEqual(expect.arrayContaining([...boundScopeSources(query.history)]))
 })
 async function sinkTurn(clearance: 'public' | 'internal', revokeAfterFirst = false, replaceAccumulator = false) {
  const {f,query}=await setup(),authority=await f.modelContext(f.firstId)
  authority.accumulator.note({sources:boundScopeSources(query.history)})
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const seen:QueryEvent[]=[],recipient={...authority.execution.security.ceiling,clearance}
  const provider:LLMProvider={name:'fictional-sink',models:['fixture'],createSession:()=>({send:()=> (async function*(){
   yield{type:'message_start' as const,model:'fixture'};yield{type:'text_delta' as const,text:'Fictional admitted response'}
   yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
  })()}),stream(){throw new Error('Unexpected fixture fallback')}}
  const run=()=>runAssistantTurn({sessionId:f.session.id,policy:{admission:'room'},lease:{mode:'none'},abortController:new AbortController(),
   model:{provider,model:'fixture',configuredProviders:undefined,customLlm:null},
   loop:{ledger:NOOP_TURN_LEDGER,context,systemPrompt:'Fictional checked history',runtimeSystemContext:JSON.stringify(query.history),
    messages:[{role:'user',content:'Summarize the fictional admitted history.'}],tools:new Map(),maxTurns:1},
   sink:{kind:'sse',assertOutputAuthority:async current=>{await validateAttendedAudienceEvidence(authority.execution,authority.accumulator.evidence,recipient);if(replaceAccumulator)current.scopeAccumulator=new ContextScopeAccumulator()},
    onEvent:async event=>{seen.push(event);if(revokeAfterFirst&&seen.length===1)await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])}}})
  return{run,seen}
 }
 it('refuses a narrowed actual recipient before any kernel event is exposed',async()=>{
  const turn=await sinkTurn('public')
  await expect(turn.run()).rejects.toMatchObject({reason:'delivery_audience_unverified',retrySafe:false,diagnostic:'clearance'})
  expect(turn.seen).toEqual([])
 })
 it('refuses a sink callback that replaces the live accumulator after current admission',async()=>{
  const turn=await sinkTurn('internal',false,true)
  await expect(turn.run()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(turn.seen).toEqual([])
 })
 it('delivers admitted events through the current native recipient at the kernel sink',async()=>{
  const turn=await sinkTurn('internal')
  await expect(turn.run()).resolves.toMatchObject({aborted:false})
  expect(turn.seen.some(event=>event.type==='text_delta'&&event.text==='Fictional admitted response')).toBe(true)
 })
 it('stops an actual native kernel stream after membership contracts between events',async()=>{
  const turn=await sinkTurn('internal',true)
  await expect(turn.run()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(turn.seen).toHaveLength(1)
 })
 function researchProvider(before?:()=>Promise<void>):LLMProvider{return{name:'fictional-research',models:['fixture'],createSession(){throw new Error('Unexpected fixture query session')},async *stream(){
  await before?.();yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:JSON.stringify({research:true,reason:'fictional evidence request'})}
  yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2}}
 }}}
 async function researchInput(){
  const {f,rows}=await setup(),message=rows.at(-1)!
  await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[message.id,JSON.stringify([{type:'text',text:'Compare the fictional options using several independent sources and explain their current differences.'}])])
  return{f,message}
 }
 it('preserves actual authored body and history observations through research assessment',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId)
  const result=await classifyAttendedResearchMessage({authority,session:f.session,message,provider:researchProvider(),model:'fixture'})
  expect(result.research).toBe(true)
  expect(boundScopeSources(result)).toEqual(expect.arrayContaining(authority.accumulator.evidence.sources??[]))
  expect(boundScopeSources(result).some(source=>source.resourceKind==='application_field')).toBe(true)
 })
 it('refuses withdrawn assessment input before provider dispatch and keeps a current reader usable',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId);let calls=0
  const provider=researchProvider(async()=>{calls++})
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(classifyAttendedResearchMessage({authority,session:f.session,message,provider,model:'fixture'})).rejects.toMatchObject({reason:'authority_changed'})
  expect(calls).toBe(0)
  const second=await f.modelContext(f.secondId)
  expect((await classifyAttendedResearchMessage({authority:second,session:f.session,message,provider,model:'fixture'})).research).toBe(true)
  expect(calls).toBe(1)
 })
 it('does not turn research assessment revocation during output into ordinary fallback',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId)
  await expect(classifyAttendedResearchMessage({authority,session:f.session,message,model:'fixture',provider:researchProvider(async()=>{
   await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
  })})).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
 })
 function classifierProvider(before?:()=>Promise<void>):LLMProvider{return{name:'fictional-topic',models:['fixture'],createSession(){throw new Error('Unexpected fixture query session')},async *stream(){
  await before?.();yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:JSON.stringify({topic_label:'Fictional admitted topic',state:'continue',confidence:0.9})};
  yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2}}
 }}}
 it('keeps an admitted trivial topic ephemeral without adding history-derived annotation nodes',async()=>{
  const {f}=await setup(),message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  let calls=0
  for(let round=0;round<2;round++){
   const authority=await f.modelContext()
   const result=await classifyAttendedSessionMessage({authority,session:f.session,message,model:'fixture',provider:classifierProvider(async()=>{calls++})})
   expect(result.classification).toMatchObject({confidence:0,usage:null})
   expect(boundScopeSources(result.classification).some(source=>source.resourceKind==='application_field')).toBe(true)
   expect(result.history.some(row=>row.id===message.id)).toBe(true)
  }
  expect(calls).toBe(0)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toEqual([])
 })
 it('keeps a greeting with explicit reply context on the durable classifier path',async()=>{
  const {f,rows}=await setup(),message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'hi'}],scope:f.envelope})
  let calls=0
  const result=await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message,model:'fixture',
   reply:{channelType:'web',replyToMessageId:rows[0].id},provider:classifierProvider(async()=>{calls++})})
  expect(calls).toBe(1)
  expect(result.classification.confidence).toBe(0.9)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(1)
 })
 it('preserves the admitted topic after more than eight unannotated greetings',async()=>{
  const {f,rows}=await setup()
  await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message:rows.at(-1)!,model:'fixture',provider:classifierProvider()})
  let message=rows.at(-1)!
  for(let i=0;i<9;i++)message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'hi'}],scope:f.envelope})
  let calls=0
  const result=await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message,model:'fixture',provider:classifierProvider(async()=>{calls++})})
  expect(result.classification.topic_label).toBe('fictional admitted topic')
  expect(calls).toBe(0)
 },60_000)
 it('shares one canonical capture across research and topic while retaining their bound sources',async()=>{
  const {f}=await setup(),authority=await f.modelContext()
  const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  let calls=0
  const provider=classifierProvider(async()=>{calls++})
  expect(await classifyAttendedResearchMessage({authority,session:f.session,message,capture,provider,model:'fixture'})).toMatchObject({research:false})
  const topic=await classifyAttendedSessionMessage({authority,session:f.session,message,capture,provider,model:'fixture'})
  expect(topic.classification.confidence).toBe(0)
  expect(boundScopeSources(topic.classification)).toEqual(expect.arrayContaining(boundScopeSources(topic.history)))
  expect(calls).toBe(0)
 })
 it('runs independent assessments concurrently over one current captured cohort',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId)
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  const researchBranch=forkAttendedSessionClassification({authority,session:f.session,message,capture})
  const topicBranch=forkAttendedSessionClassification({authority,session:f.session,message,capture})
  let entered=0,release!:()=>void
  const bothEntered=new Promise<void>(resolve=>{release=resolve})
  const rendezvous=async()=>{entered++;if(entered===2)release();await bothEntered}
  const [research,assessment]=await Promise.all([
   classifyAttendedResearchMessage({...researchBranch,session:f.session,message,provider:researchProvider(rendezvous),model:'fixture'}),
   assessAttendedSessionMessage({...topicBranch,session:f.session,message,provider:classifierProvider(rendezvous),model:'fixture'}),
  ])
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(0)
  researchBranch.mergeEvidence()
  const topic=await assessment.publish()
  topicBranch.mergeEvidence()
  expect(entered).toBe(2)
  expect(research.research).toBe(true)
  expect(topic.classification.topic_label).toBe('fictional admitted topic')
  expect(boundScopeSources(research)).toEqual(expect.arrayContaining(boundScopeSources(topic.history)))
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(1)
 })
 it('isolates branch evidence expansion and merges only explicitly into the turn',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId)
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  const first=forkAttendedSessionClassification({authority,session:f.session,message,capture})
  const second=forkAttendedSessionClassification({authority,session:f.session,message,capture})
  const before=JSON.stringify(authority.accumulator.evidence)
  first.authority.accumulator.note({sensitivity:'confidential'})
  expect(JSON.stringify(authority.accumulator.evidence)).toBe(before)
  expect(JSON.stringify(second.authority.accumulator.evidence)).toBe(before)
  first.mergeEvidence()
  expect(authority.accumulator.evidence.sensitivity).toBe('confidential')
  expect(first.authority.execution).toBe(authority.execution)
  expect(second.authority.execution).toBe(authority.execution)
 })
 it('does not append annotation evidence while a sibling research assessment is pending',async()=>{
  const {f,message}=await researchInput(),authority=await f.modelContext(f.firstId)
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  let release!:()=>void,started!:()=>void
  const pending=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
  const research=classifyAttendedResearchMessage({authority,session:f.session,message,capture,
   provider:researchProvider(async()=>{started();await pending}),model:'fixture'})
  await entered
  const before=JSON.stringify(authority.accumulator.evidence)
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message,capture,provider:classifierProvider(),model:'fixture'})
  expect(JSON.stringify(authority.accumulator.evidence)).toBe(before)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(0)
  release()
  await expect(research).resolves.toMatchObject({research:true})
  await assessment.publish()
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(1)
 })
 it.each(['hold','edit'] as const)('revalidates a deferred ephemeral assessment after source %s',async change=>{
  const {f}=await setup(),authority=await f.modelContext(f.firstId)
  const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'hi'}],scope:f.envelope})
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message,provider:classifierProvider(),model:'fixture'})
  if(change==='hold')await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[message.id])
  else await f.pool.query(`UPDATE session_messages SET content='[{"type":"text","text":"Fictional replacement"}]'::jsonb WHERE id=$1`,[message.id])
  await expect(assessment.publish()).rejects.toMatchObject({reason:'authority_changed'})
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(0)
 })
 it.each(['hold','edit','membership'] as const)('refuses a shared classification capture after %s changes',async change=>{
  const {f}=await setup(),authority=await f.modelContext(f.firstId)
  const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  const provider=classifierProvider()
  await classifyAttendedResearchMessage({authority,session:f.session,message,capture,provider,model:'fixture'})
  if(change==='hold')await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[message.id])
  else if(change==='edit')await f.pool.query(`UPDATE session_messages SET content='[{"type":"text","text":"Fictional edited request"}]'::jsonb WHERE id=$1`,[message.id])
  else await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(classifyAttendedSessionMessage({authority,session:f.session,message,capture,provider,model:'fixture'})).rejects.toMatchObject({reason:'authority_changed'})
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toEqual([])
 })
 it('refuses forged classification handles and handles belonging to another authority',async()=>{
  const {f}=await setup(),authority=await f.modelContext()
  const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  const capture=await captureAttendedSessionClassification({authority,session:f.session,message})
  for(const input of [{authority,capture:{}},{authority:await f.modelContext(),capture}]){
   await expect(classifyAttendedSessionMessage({...input,session:f.session,message,provider:classifierProvider(),model:'fixture'}))
    .rejects.toMatchObject({code:'scope_evidence_missing'})
  }
 })
 it('still publishes a trivial message annotation when an explicit admitted reply target needs interpretation',async()=>{
  const {f,rows}=await setup(),message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  let calls=0
  const result=await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message,model:'fixture',
   provider:classifierProvider(async()=>{calls++}),reply:{channelType:'web',replyToMessageId:rows[0].id}})
  expect(result.reply).not.toBeNull()
  expect(calls).toBe(1)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(1)
 })
 it('refuses a held trivial input instead of returning an ephemeral topic',async()=>{
  const {f}=await setup(),message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  const authority=await f.modelContext();let calls=0
  await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[message.id])
  await expect(classifyAttendedSessionMessage({authority,session:f.session,message,model:'fixture',provider:classifierProvider(async()=>{calls++})}))
   .rejects.toMatchObject({code:'scope_source_changed'})
  expect(calls).toBe(0)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toEqual([])
 })
 it('keeps non-text messages on the original annotation path even when their text is trivial',async()=>{
  const {f}=await setup(),message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[
   {type:'text',text:'test'},{type:'image',source:{type:'base64',mediaType:'image/png',data:'fictional-image'}}],scope:f.envelope})
  await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message,model:'fixture',provider:classifierProvider()})
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE message_id=$1',[message.id])).rows).toHaveLength(1)
 })
 it('publishes a real immutable topic annotation from the complete admitted history',async()=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  const result=await classifyAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  expect(result.classification.topic_label).toBe('fictional admitted topic')
  const annotation=await readSessionMessageAnnotation(f.session.id,rows.at(-1)!.id,authority)
  expect(annotation?.topicLabel).toBe('fictional admitted topic')
  const history=await readAttendedSessionHistory(await f.modelContext(),f.session.id)
  expect(history.at(-1)?.topicLabel).toBe('fictional admitted topic')
  expect(boundScopeSources(result.classification).some(source=>source.resourceKind==='application_field')).toBe(true)
 })
 it('refuses a classifier result after actual membership withdrawal and persists no annotation',async()=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  await expect(classifyAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,model:'fixture',
   provider:classifierProvider(async()=>{await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.ownerId])})})).rejects.toMatchObject({reason:'authority_changed'})
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 async function classified(clearance:'internal'|'confidential'='internal'){
  const {f,rows}=await setup(clearance),authority=await f.modelContext()
  const result=await classifyAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  return{f,rows,authority,result}
 }
 it('uses a pending topic with freshly revalidated history and no early annotation write',async()=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  const result=await assessment.defer()
  expect(result.classification.topic_label).toBe('fictional admitted topic')
  expect(result.pendingAnnotation).toBeDefined()
  expect(await readSessionMessageAnnotation(f.session.id,rows.at(-1)!.id,await f.modelContext())).toBeNull()
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery'),topics=vi.spyOn(sessionQueries,'captureSessionTopics')
  result.history[0].content=[{type:'text',text:'Untrusted mutation'}]
  const history=await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(full).not.toHaveBeenCalled();expect(topics).not.toHaveBeenCalled()
  expect(history[0].content).toEqual(rows[0].content)
  expect(history.at(-1)?.topicLabel).toBeNull()
  expect(await attendedSessionTurnCount(authority,history)).toBe(2)
 })
 it('recaptures an older topic added while the current topic is pending',async()=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  const result=await assessment.defer()
  await classifyAttendedSessionMessage({authority:await f.modelContext(),session:f.session,message:rows[0],provider:classifierProvider(),model:'fixture'})
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  const history=await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(full).toHaveBeenCalledTimes(1)
  expect(history[0].topicLabel).toBe('fictional admitted topic')
 })
 it('does not expose pending-history bytes after membership withdrawal',async()=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  const result=await assessment.defer()
  await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.ownerId])
  await expect(readClassifiedSessionHistory(authority,f.session.id,result.history)).rejects.toMatchObject({reason:'authority_changed'})
 })
 it.each(['edit','hold'] as const)('rechecks topic source %s after assessment and before transient use',async change=>{
  const {f,rows}=await setup(),authority=await f.modelContext()
  const assessment=await assessAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  if(change==='edit')await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',
   [rows[0].id,JSON.stringify([{type:'text',text:'Fictional replacement input'}])])
  else await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[rows[0].id])
  await expect(assessment.defer()).rejects.toBeDefined()
  expect(await readSessionMessageAnnotation(f.session.id,rows.at(-1)!.id,await f.modelContext())).toBeNull()
 })
 it('reuses private body bytes with fresh topics and complete query evidence after classification',async()=>{
  const {f,rows,authority,result}=await classified()
  // Public returned arrays cannot alter the private retained body receipt.
  result.history[0].content=[{type:'text',text:'Untrusted later replacement'}]
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery'),topics=vi.spyOn(sessionQueries,'captureSessionTopics')
  const reused=await readClassifiedSessionHistory(authority,f.session.id,result.history,rows[1].sequenceNum)
  expect(full).not.toHaveBeenCalled();expect(topics).toHaveBeenCalledTimes(1)
  expect(reused.at(-1)?.topicLabel).toBe('fictional admitted topic')
  expect(await attendedSessionTurnCount(authority,reused)).toBe(2)
  const original=await readAttendedSessionHistory(await f.modelContext(),f.session.id,rows[1].sequenceNum)
  expect(reused).toEqual(original)
  const sourceKeys=(value:object)=>[...boundScopeSources(value)].sort((a,b)=>
   JSON.stringify([a.resourceKind,a.resourceId,a.version]).localeCompare(JSON.stringify([b.resourceKind,b.resourceId,b.version])))
  expect(sourceKeys(reused)).toEqual(sourceKeys(original))
  expect(boundScopeSources(reused).filter(source=>source.resourceKind==='application_field').length).toBeGreaterThan(2)
 })
 it('recaptures when a new input advances the classified history ceiling',async()=>{
  const {f,authority,result}=await classified()
  const added=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional follow-up input'}],scope:f.envelope})
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  const history=await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(full).toHaveBeenCalledTimes(1);expect(history.at(-1)?.id).toBe(added.id)
 })
 it('recaptures after the current annotation head is replaced',async()=>{
  const {f,rows,authority,result}=await classified()
  await classifyAttendedSessionMessage({authority,session:f.session,message:rows.at(-1)!,provider:classifierProvider(),model:'fixture'})
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(full).toHaveBeenCalledTimes(1)
 })
 it('recaptures changed bodies and preserves the original accumulator conflict',async()=>{
  const {f,rows,authority,result}=await classified()
  await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[rows[0].id,JSON.stringify([{type:'text',text:'Fictional amended request'}])])
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  await expect(readClassifiedSessionHistory(authority,f.session.id,result.history)).rejects.toMatchObject({code:'scope_source_changed'})
  expect(full).toHaveBeenCalledTimes(1)
  await expect(readAttendedSessionHistory(authority,f.session.id)).rejects.toMatchObject({code:'scope_source_changed'})
  const history=await readAttendedSessionHistory(await f.modelContext(),f.session.id)
  expect(history[0].content).toEqual([{type:'text',text:'Fictional amended request'}])
 })
 it('revalidates retained bodies at the shared floor even when the actor can read confidential rows',async()=>{
  const {f,rows,authority,result}=await classified()
  await f.pool.query("UPDATE session_messages SET sensitivity='confidential' WHERE id=$1",[rows[0].id])
  const reused=await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(reused).toEqual(await readAttendedSessionHistory(authority,f.session.id))
  expect(reused.map(row=>row.id)).not.toContain(rows[0].id)
  const fresh=await readAttendedSessionHistory(await f.modelContext(),f.session.id)
  expect(fresh.map(row=>row.id)).not.toContain(rows[0].id)
  expect(JSON.stringify(fresh)).not.toContain('Fictional earlier request')
 })
 it('honors a current native body-field policy extension through the original fallback',async()=>{
  const {f,authority,result}=await classified()
  const original=(await f.pool.query<{definition:string;body:string}>(`SELECT pg_get_functiondef(oid) AS definition,prosrc AS body
   FROM pg_proc WHERE oid='public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'::regprocedure`)).rows[0]
  const outcome=async(read:()=>Promise<unknown>)=>{
   try{return{value:await read()}}
   catch(error){const e=error as {message:string;code?:string;reason?:string};return{error:{message:e.message,code:e.code,reason:e.reason}}}
  }
  try{
   await f.pool.query(original.definition.replace(original.body,original.body.replace('BEGIN',
    `BEGIN\n IF w='${f.workspaceId}'::uuid AND t='session_message' AND 'content'=ANY(fields) THEN RETURN NULL;END IF;`)))
   const expected=await outcome(()=>readAttendedSessionHistory(authority,f.session.id))
   const actual=await outcome(()=>readClassifiedSessionHistory(authority,f.session.id,result.history))
   expect(actual).toEqual(expected)
   expect(JSON.stringify(actual)).not.toContain('Fictional earlier request')
   expect(JSON.stringify(actual)).not.toContain('Fictional current request')
  }finally{await f.pool.query(original.definition)}
 })
 it('prepares fresh independent authority for an earlier annotation added after classification',async()=>{
  const {f,rows,authority,result}=await classified('confidential')
  independent=await persistentSourceFixture(f)
  const bind=(current:typeof authority)=>bindSessionContextRetainedAuthority(current.execution,
   (execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  bind(authority)
  const writer=await f.modelContext();bind(writer)
  const annotation=await writeSessionContextRevision({sessionId:f.session.id,parentId:rows[0].id,kind:'message_annotation',
   content:{topicLabel:'fictional independent topic',topicConfidence:0.9,replyToText:null},authority:writer,
   derivation:{producer:'fixture:independent-topic',sources:[independent.root]}})
  expect(annotation).not.toBeNull()
  const full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  const reused=await readClassifiedSessionHistory(authority,f.session.id,result.history)
  expect(full).not.toHaveBeenCalled()
  expect(reused[0].topicLabel).toBe('fictional independent topic')
  expect(boundScopeSources(reused).some(source=>source.resourceKind==='external_source')).toBe(true)
  const current=await f.modelContext();bind(current)
  expect(reused).toEqual(await readAttendedSessionHistory(current,f.session.id))
  await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  const after={execution:authority.execution,accumulator:new ContextScopeAccumulator()}
  const withdrawn=await readClassifiedSessionHistory(after,f.session.id,result.history)
  expect(withdrawn[0].topicLabel).toBeNull()
  const fresh=await f.modelContext();bind(fresh)
  expect(withdrawn).toEqual(await readAttendedSessionHistory(fresh,f.session.id))
 },60_000)
 it('does not accept a copied receipt or reuse one for a different canonical execution',async()=>{
  const {f,authority,result}=await classified(),full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  await readClassifiedSessionHistory(authority,f.session.id,[...result.history])
  await readClassifiedSessionHistory(await f.modelContext(),f.session.id,result.history)
  expect(full).toHaveBeenCalledTimes(2)
 })
 it('refuses withdrawn authority before a retained body can be returned',async()=>{
  const {f,authority,result}=await classified(),full=vi.spyOn(sessionQueries,'readAdmittedSessionQuery')
  await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.ownerId])
  await expect(readClassifiedSessionHistory(authority,f.session.id,result.history)).rejects.toMatchObject({reason:'authority_changed'})
  expect(full).not.toHaveBeenCalled()
 })
})
