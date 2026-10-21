import {runAssistantTurn} from '../../turn/kernel.js'
import {validateAttendedAudienceEvidence} from '../../context-scope/attended-audience.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,type QueryEvent,type LLMProvider} from '@use-brian/core'
import {classifyAttendedSessionMessage,readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {readSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {resolveReplyText} from '../../routes/_reply-context.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual admitted reply history',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,rows=await f.history()
  await f.pool.query('UPDATE session_messages SET channel_message_id=$2 WHERE id=$1',[rows[1].id,'fictional-channel-reply'])
  const authority=await f.modelContext(),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:rows.at(-1)!.sequenceNum,authority})
  return{f,rows,query}
 }
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
 function classifierProvider(before?:()=>Promise<void>):LLMProvider{return{name:'fictional-topic',models:['fixture'],createSession(){throw new Error('Unexpected fixture query session')},async *stream(){
  await before?.();yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:JSON.stringify({topic_label:'Fictional admitted topic',state:'continue',confidence:0.9})};
  yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2}}
 }}}
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
})
