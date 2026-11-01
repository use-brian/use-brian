import {runAssistantTurn} from '../../turn/kernel.js'
import {validateAttendedAudienceEvidence} from '../../context-scope/attended-audience.js'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,type QueryEvent,type LLMProvider} from '@use-brian/core'
import {captureAttendedSessionClassification,classifyAttendedSessionMessage,classifyAttendedResearchMessage,readAttendedSessionHistory,readClassifiedSessionHistory,attendedSessionTurnCount} from '../../routes/attended-session-context.js'
import * as sessionQueries from '../../db/session-query-reader.js'
import {addSessionMessage} from '../../db/sessions.js'
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
