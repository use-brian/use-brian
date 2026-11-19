/** [COMP:api/conversation-visibility] Native record receiving boundary.
 * The provider is local. The original kernel, native reader and writer,
 * derivation, credential, frame and hold checks all use the real database. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {NOOP_TURN_LEDGER} from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type {LLMProvider,Message} from '@use-brian/agent-runtime/providers/types.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {buildRecordAdmissionCandidate}=await import(new URL('../../../scripts/conversation-store/build-conversation-record-admission.mjs',import.meta.url).href)
const {getPool,getAppPool,queryWithRLS}=await import('../../db/client.js')
const {persistentContextFixture}=await import('../../application-platform/__tests__/fixtures/persistent-context.js')
const {authSessionStore}=await import('../../db/auth-session-store.js')
const {addSessionMessage,readSessionById,toStampedMessages}=await import('../../db/sessions.js')
const {findAssistantById}=await import('../../db/users.js')
const {resolveExecutionContextSystem}=await import('../../context-scope/execution-context.js')
const {createTurnDeliveryAdmission}=await import('../../context-scope/admission.js')
const {admitTurnConversationRecords}=await import('../../context-scope/conversation-record-admission.js')
const {openAssistantTurn}=await import('../kernel.js')
const {assessAttendedSessionMessage,captureAttendedSessionClassification}=await import('../../routes/attended-turn-routing.js')
const {prepareAttendedRecordTitle}=await import('../../routes/attended-session-title.js')
const {changeConversationVisibility,raiseConversationCap}=await import('../../db/conversation-visibility.js')
const {captureNativeConversationRecord}=await import('../../db/conversation-record.js')
const {createMemory}=await import('../../db/memories.js')

beforeAll(async()=>{
 const client=await getPool().connect()
 try {
  const installed=await client.query("SELECT to_regprocedure('public.capture_conversation_record_current(uuid,uuid,integer,integer,integer,jsonb)') IS NOT NULL installed")
  if(!installed.rows[0].installed)await client.query(await buildRecordAdmissionCandidate())
 }
 catch(error){
  const sql=error as {code?:string;message?:string;detail?:string;where?:string}
  console.log(JSON.stringify({stage:'record_candidate_installation',code:sql.code,message:sql.message,detail:sql.detail,where:sql.where}))
  throw error
 }
 finally{await client.query('ROLLBACK');client.release()}
},30_000)
afterAll(async()=>{await getAppPool().end();await getPool().end()})

type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
function localProvider(seen:unknown[],delta='Fictional record answer.'):LLMProvider{
 return {name:'fictional-record-provider',models:[],stream(){throw new Error('Unexpected stateless dispatch')},
  createSession(session){
   seen.push(session)
   return {send(...input){
    seen.push(input)
    return (async function*(){
     yield {type:'message_start' as const,model:'fictional-record'}
     yield {type:'text_delta' as const,text:delta}
     yield {type:'text_delta' as const,text:' Second frame.'}
     yield {type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
    })()
   }}
  }}
}

async function prepare(f:Fixture,device:NonNullable<Awaited<ReturnType<typeof authSessionStore.create>>>,seen:unknown[],
 currentInput?:Awaited<ReturnType<typeof addSessionMessage>>){
 const session=(await readSessionById(f.session.id))!,assistant=(await findAssistantById(f.assistantId))!,abort=new AbortController()
 const {executionContext:execution}=await resolveExecutionContextSystem({
  userId:f.ownerId,workspaceId:f.workspaceId,assistant,memberMode:'member',
  sharedAudience:true,session,sessionAuthority:session,
  identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
  nativeSessionCredential:{userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion},
  ownership:{kind:'workspace',workspaceId:f.workspaceId},
  lifecycle:{sessionId:session.id,sessionPersisted:true,channelId:session.channelId,channelType:session.channelType,abortSignal:abort.signal},
 })
 const accumulator=new ContextScopeAccumulator(),native={execution,accumulator}
 const permissionContext=createTurnDeliveryAdmission(execution,accumulator,session)
 if(!permissionContext)throw Error('The receiving native SSE binding is unavailable')
 const context={...executionToolContext(execution,{appId:'native-record-fixture'}),scopeAccumulator:accumulator}
 const turn=await openAssistantTurn({sessionId:session.id,assistantId:assistant.id,policy:{admission:'room'},abortController:abort})
 try{
  turn.bindModelPreparation({kind:'execution',toolProfile:'web',execution,assertCurrent:()=>execution.security.authority.assertCurrent()},
   {provider:localProvider(seen),configuredProviders:undefined,resolveWorkspaceCustomLlm:null,resolveLegacyByoKey:null,buildLegacyByoProvider:null})
  let pendingAnnotation:object|undefined
  if(currentInput){
   const input={authority:native,session,message:currentInput}
   const capture=await captureAttendedSessionClassification(input)
   expect(accumulator.evidence.sources?.map(source=>source.resourceKind)).toEqual(['conversation_record'])
   const classify=async function*(){
    yield {type:'message_start',model:'fictional-record'}
    yield {type:'text_delta',text:'{"topic_label":"Fictional record topic","state":"continue","confidence":0.9}'}
    yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
   } satisfies LLMProvider['stream']
   const provider:LLMProvider={name:'fictional-record-classifier',models:['fictional-record'],stream:classify,
    createSession:()=>({send:classify})}
   const assessment=await assessAttendedSessionMessage({...input,capture,provider,model:'fictional-record'})
   const classified=await assessment.defer()
   expect(classified.classification.topic_label).toBe('fictional record topic')
   pendingAnnotation=classified.pendingAnnotation
  }
  const history=await turn.prepareHistory({native,evidence:accumulator})
  expect(history.source).toBe('record')
  const root=accumulator.evidence.sources?.find(source=>source.resourceKind==='conversation_record')
  expect(root).toBeDefined()
  await turn.prepareMainModel({kind:'web',requestedModel:'pro',plan:'max_5x',budgetStatus:'ok',researchMode:false,metered:null,hasImage:false})
  await turn.prepareRun({systemPrompt:'Fictional record prompt',messages:toStampedMessages(history.messages,'UTC') as Message[],candidateTools:new Map()})
  return {turn,native,execution,accumulator,context,permissionContext,root:root as ScopeSource,history,pendingAnnotation}
 }catch(error){permissionContext.dispose();await turn.finish('failed');throw error}
}

describe.sequential('[COMP:api/conversation-visibility] Native record kernel receiving path',()=>{
 it('allows a current participant to save a contained private memory and rolls back a broader or withdrawn write',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const original=await f.history()
   const actor=async(userId:string)=>{
    const device=(await authSessionStore.create(userId,{deviceLabel:'Fictional derivative device',userAgent:null,ipAddress:null}))!
    return {userId,authSessionId:device.id,authVersion:device.authVersion}
   }
   const owner=await actor(f.ownerId),reader=await actor(f.secondId)
   await changeConversationVisibility(owner,f.session.id,{expectedVersion:1,visibility:'configured_private',participantUserIds:[f.secondId]})
   const record=await captureNativeConversationRecord(owner,{workspaceId:f.workspaceId,sessionId:f.session.id,
    afterSequence:0,throughSequence:3,topicThroughSequence:0})
   const save=(userId:string|null,summary:string)=>createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,
    userId,summary,createdByUserId:reader.userId,sensitivity:'internal',
    derivationTarget:{userId,assistantId:null},derivation:{producer:'fixture:conversation-memory',sources:[record.source]}})
   const narrowed=await save(reader.userId,'Fictional private record note')
   expect(narrowed).toMatchObject({userId:reader.userId,assistantId:null})
   expect((await f.pool.query(`SELECT s.source_kind,s.source_id FROM scope_derivations d JOIN scope_derivation_sources s
    ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2`,
    [f.workspaceId,narrowed.id])).rows).toEqual([{source_kind:'conversation_record',source_id:record.source.resourceId}])
   await expect(save(null,'Fictional excessive audience')).rejects.toMatchObject({code:'42501'})
   expect((await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Fictional excessive audience'",[f.workspaceId])).rows).toEqual([])
   await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[original[0].id])
   await expect(save(reader.userId,'Fictional stale record note')).rejects.toMatchObject({code:'scope_source_changed'})
  }finally{await f.cleanup()}
 })
 it('withdraws saved record derivatives and their descendants synchronously while intact dialogue reopens',async test=>{
  const installed=await getPool().query("SELECT to_regprocedure('public.hold_conversation_record_dependents(uuid,text,uuid)') IS NOT NULL enabled")
  if(!installed.rows[0].enabled)return test.skip()
  const f=await persistentContextFixture('internal')
  try{
   const original=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional derivative withdrawal',userAgent:null,ipAddress:null}))!
   const actor={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const record=await captureNativeConversationRecord(actor,{workspaceId:f.workspaceId,sessionId:f.session.id,
    afterSequence:0,throughSequence:3,topicThroughSequence:0})
   const save=(summary:string,source:ScopeSource)=>createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,
    userId:f.ownerId,summary,createdByUserId:f.ownerId,sensitivity:'internal',
    derivationTarget:{userId:f.ownerId,assistantId:null},derivation:{producer:'fixture:transitive-record-memory',sources:[source]}})
   const retained=await save('Fictional retained note',record.source)
   const retainedSource={...f.envelope,userId:f.ownerId,resourceKind:'memory',resourceId:retained.id,version:retained.scopeVersion} as const
   const child=await save('Fictional downstream note',retainedSource)
   const active=await queryWithRLS(f.ownerId,'SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[retained.id,child.id]])
   expect(active.rowCount).toBe(2)
   const mapped=await f.pool.query(`SELECT dependency_kind,dependency_id FROM conversation_record_derivation_dependencies
    WHERE workspace_id=$1 ORDER BY dependency_kind,dependency_id`,[f.workspaceId])
   expect(mapped.rows).toEqual(expect.arrayContaining([{dependency_kind:'conversation_session',dependency_id:f.session.id},
    {dependency_kind:'session_message',dependency_id:original[0].id}]))
   await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[original[0].id])
   const held=await f.pool.query('SELECT id,scope_held FROM memories WHERE id=ANY($1::uuid[])',[[retained.id,child.id]])
   expect(held.rows).toHaveLength(2)
   expect(held.rows.every(row=>row.scope_held)).toBe(true)
   expect((await queryWithRLS(f.ownerId,'SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[retained.id,child.id]])).rowCount).toBe(0)
   const reopened=await captureNativeConversationRecord(actor,{workspaceId:f.workspaceId,sessionId:f.session.id,
    afterSequence:0,throughSequence:3,topicThroughSequence:0})
   expect(JSON.stringify(reopened.rows)).toContain('Fictional earlier response')
   expect(JSON.stringify(reopened.rows)).not.toContain('Fictional earlier request')
   await expect(save('Fictional withdrawn quote',record.source)).rejects.toMatchObject({code:'scope_source_changed'})
  }finally{await f.cleanup()}
 })
 it('publishes after the original turn lease, preserves the title across a cap update and withdraws a selected hold',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const rows=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional title device',userAgent:null,ipAddress:null}))!
   const original=await prepare(f,device,[])
   original.permissionContext.dispose();await original.turn.finish('completed')
   const authority=await prepareAttendedRecordTitle(original.native,{userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion})
   const complete=async function*(){
    yield {type:'message_start',model:'fictional-record'}
    yield {type:'text_delta',text:'Fictional Native Title'}
    yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
   } satisfies LLMProvider['stream']
   const provider:LLMProvider={name:'fictional-record-title',models:['fictional-record'],stream:complete,createSession:()=>({send:complete})}
   const result=await authority.generate(provider,'fictional-record')
   expect(result).toMatchObject({title:'Fictional Native Title',written:true})
   const readTitle=async()=> (await queryWithRLS<{value:unknown}>(f.ownerId,'SELECT read_conversation_title_current($1) AS value',[f.session.id])).rows[0].value
   expect(await readTitle()).toMatchObject({title:'Fictional Native Title'})
   await raiseConversationCap({userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion},f.session.id,{expectedVersion:1,cap:'confidential'})
   expect(await readTitle()).toMatchObject({title:'Fictional Native Title'})
   await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[rows[0].id])
   expect(await readTitle()).toBeNull()
  }finally{await f.cleanup()}
 })
 it('classifies the exact authored row with record evidence and commits its annotation with the reply',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   const current=await addSessionMessage({sessionId:f.session.id,role:'user',senderUserId:f.ownerId,
    content:[{type:'text',text:'Review the fictional controls and compare possible outcomes.'}],scope:f.envelope})
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional record classifier device',userAgent:null,ipAddress:null}))!
   const prepared=await prepare(f,device,[],current)
   const {turn,native,execution,accumulator,context,permissionContext,pendingAnnotation}=prepared
   try{
    expect(pendingAnnotation).toBeDefined()
    await turn.run({loop:{ledger:NOOP_TURN_LEDGER,maxTurns:1,context},sink:{
     kind:'sse',permissionContext,admitOutput:permissionContext.authorizeDelivery,onEvent(){},
     async afterLoop(){
      await turn.publish({disposition:'reply',native,pendingAnnotation,execute:operation=>execution.security.authority.execute(operation),
       write:{derivation:{producer:'fixture:classified-record-turn',sources:accumulator.evidence.sources!},derivationTarget:f.envelope},
       rows:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'Fictional classified reply.'}]}]})
     },
    }})
    expect((await f.pool.query(`SELECT c.content FROM session_message_annotation_heads h JOIN session_context_revision_contents c
     ON c.workspace_id=h.workspace_id AND c.revision_id=h.scope_revision_id WHERE h.session_id=$1 AND h.message_id=$2`,[f.session.id,current.id])).rows)
     .toEqual([{content:{topicLabel:'fictional record topic',topicConfidence:0.9,replyToText:null}}])
   }finally{prepared.permissionContext.dispose();await prepared.turn.finish('completed')}
  }finally{await f.cleanup()}
 })
 it('dispatches the record, admits each frame, publishes its edge and reopens after origination and withdrawal',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const previous=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional record receiving device',userAgent:null,ipAddress:null}))!
   const seen:unknown[]=[],delivered:string[]=[]
   const prepared=await prepare(f,device,seen)
   let publishedId:string|undefined
   try{
    const {turn,native,execution,accumulator,context,permissionContext,root}=prepared
    expect(accumulator.evidence.sources).toEqual([root])
    await turn.run({loop:{ledger:NOOP_TURN_LEDGER,maxTurns:1,context},sink:{
     kind:'sse',permissionContext,admitOutput:permissionContext.authorizeDelivery,
     onEvent(event){if(event.type==='text_delta')delivered.push(event.text)},
     async afterLoop(){
      const [published]=await turn.publish({disposition:'reply',native,execute:operation=>execution.security.authority.execute(operation),
       write:{derivation:{producer:'fixture:record-turn',sources:accumulator.evidence.sources!},derivationTarget:f.envelope},
       rows:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:delivered.join('')}]}]})
      publishedId=published.id
     },
    }})
    expect(seen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen)).toContain('Fictional earlier response')
    expect(delivered.join('')).toBe('Fictional record answer. Second frame.')
    expect(publishedId).toBeDefined()
    expect((await f.pool.query(`SELECT count(*)::int AS edges FROM scope_derivation_sources edge
     JOIN scope_derivations d ON d.id=edge.derivation_id
     JOIN session_context_scope_revisions r ON d.resource_kind='session_context_revision' AND r.id=d.resource_id
     WHERE r.session_id=$1 AND r.parent_kind='turn_frame' AND edge.source_kind='conversation_record' AND edge.source_id=$2`,
    [f.session.id,root.resourceId])).rows[0].edges).toBe(1)
   }finally{prepared.permissionContext.dispose();await prepared.turn.finish('completed')}

   await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional next input.'}],scope:f.envelope})
   const next=await prepare(f,device,[])
   try{
    expect(JSON.stringify(next.history.messages)).toContain('Fictional record answer.')
    await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[previous[0].id])
    await expect(admitTurnConversationRecords(next.execution,[next.root],'dispatch')).rejects.toMatchObject({code:'42501'})
    await expect(next.permissionContext.authorizeDelivery(next.context)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
   }finally{next.permissionContext.dispose();await next.turn.finish('failed')}
   const reopened=await prepare(f,device,[])
   try{
    expect(JSON.stringify(reopened.history.messages)).toContain('Fictional record answer.')
    expect(JSON.stringify(reopened.history.messages)).not.toContain('Fictional earlier request')
   }finally{reopened.permissionContext.dispose();await reopened.turn.finish('completed')}
  }finally{await f.cleanup()}
 })
 it('refuses the next frame after the original native credential is revoked',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional revoked record device',userAgent:null,ipAddress:null}))!
   const prepared=await prepare(f,device,[]),delivered:string[]=[]
   try{
    const {turn,context,permissionContext}=prepared
    await expect(turn.run({loop:{ledger:NOOP_TURN_LEDGER,maxTurns:1,context},sink:{
     kind:'sse',permissionContext,admitOutput:permissionContext.authorizeDelivery,async onEvent(event){
      if(event.type!=='text_delta')return
      delivered.push(event.text)
      if(delivered.length===1)await authSessionStore.revokeForUser(f.ownerId,device.id)
     },
    }})).rejects.toBeDefined()
    expect(delivered).toEqual(['Fictional record answer.'])
    expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
   }finally{prepared.permissionContext.dispose();await prepared.turn.finish('failed')}
  }finally{await f.cleanup()}
 })
})
