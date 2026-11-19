import {randomUUID} from 'node:crypto'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import type {TopicClassification} from '@use-brian/core/memory/topic-classifier.js'
import type {LLMProvider, Message, StreamChunk} from '@use-brian/agent-runtime/providers/types.js'
import {chatRoutes} from '../../routes/chat.js'
import {runProactiveCompaction} from '../../routes/proactive-compaction.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../db/pending-approvals-store.js'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import * as queryFrames from '../../db/session-context-revisions.js'
import * as storedSessions from '../../db/sessions.js'
import * as audience from '../../context-scope/attended-audience.js'
import * as nativeEvidence from '../conversation-evidence.js'
import {createTurnDeliveryAdmission} from '../../context-scope/admission.js'
import {takeTurnLease,releaseTurn} from '../../turn/lease.js'
import {assertModelOutputAuthority} from '@use-brian/agent-runtime/engine/query-loop.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {bindScopeSources, boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool,applyRLSGucs,runWithAgentAccess} from '../../db/client.js'
import {validateCallerScopeEvidence,validateAudienceScopeEvidence} from '../../context-scope/caller-evidence.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession,setCompactSummaryAndBoundary,readCompactSummary,findSessionById} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {writeSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {createMemoryTools} from '@use-brian/core/memory/tools.js'
import {admitModelSourceEvidence} from '../model-source-authority.js'
import * as memoryRows from '../../db/memories.js'
import * as derivedScope from '../../db/derived-scope-store.js'
import {readPrivateTranscript} from '../../db/private-transcript.js'
import * as privateTranscripts from '../../db/private-transcript.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {restrictTitleJobAuthority} from '../../workers/session-title-worker.js'
import {restrictStateJobAuthority} from '../../workers/session-state-worker.js'
import {readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {captureAttendedSessionClassification,assessAttendedSessionMessage} from '../../routes/attended-turn-routing.js'
import {admitModelInput,admitModelOutput} from '../../context-scope/admission.js'
import {fixtureHasNativeTurnRecord,persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
// Current uploads on the native record profile receive their own authorization
// in the actual chat route, exercised by chat-authored-transcript.integration.
const legacyUpload = it.skipIf(await fixtureHasNativeTurnRecord())

describe.sequential('[COMP:api/private-transcript] ordinary private conversation continuity',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{
  vi.restoreAllMocks()
  try{if(fixture)expect((await fixture.pool.query('SELECT count(*)::int AS count FROM native_memory_query_write_intents WHERE workspace_id=$1',[fixture.workspaceId])).rows).toEqual([{count:0}])}
  finally{await fixture?.cleanup();fixture=undefined}
 })
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(member=false){
  fixture=await persistentContextFixture('confidential');const f=fixture,userId=member?f.secondId:f.ownerId
  await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
  const device=(await authSessionStore.create(userId,{deviceLabel:'Fictional continuity browser',userAgent:null,ipAddress:null}))!
  const claims={userId,sessionId:device.id,authVersion:device.authVersion}
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:userId,authSessionId:device.id,authVersion:device.authVersion})
  const scope={...f.envelope,userId,assistantId:null}
  const input=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Remember that we chose the amber notebook.'}],senderUserId:userId,scope})
  const memory=await f.memory('The fictional office currently opens at nine.',userId)
  const fresh=()=>resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
  const original=await fresh(),query=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:input.sequenceNum,authority:original})
  expect(boundScopeSources(query).some(source=>source.resourceKind==='private_transcript')).toBe(true)
  const memories=await createDbMemoryStore().getIndex(original.execution.security.access,false,original)
  original.accumulator.note({sources:[...boundScopeSources(query),...boundScopeSources(memories)]})
  const [reply]=await publishNativeSessionMessageBatch({sessionId:session.id,authority:original,derivationTarget:scope,
   derivation:{producer:'fixture:conversation',sources:[...boundScopeSources(query),...boundScopeSources(memories)]},
   messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'We chose the amber notebook. The office opens at nine.'}]}]})
  return{f,session,scope,input,reply,memory,fresh,claims,userId,device,original}
 }
 async function mixedPublication(){
  const c=await setup(),authority=await c.fresh()
  // Carry the actual earlier Memory field obligations into a fresh publication
  // together with newly captured dialogue and a real generated annotation.
  authority.accumulator.note({sources:c.original.accumulator.evidence.sources??[]})
  const history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  expect(history?.map(row=>row.id)).toEqual([c.input.id,c.reply.id])
  const classification=bindScopeSources<TopicClassification>({topic_label:'Fictional notebook discussion',state:'continue',confidence:0.9},boundScopeSources(history!))
  const annotation=await writeSessionMessageAnnotation({sessionId:c.session.id,messageId:c.input.id,classification,replyToText:null,authority})
  expect(annotation).not.toBeNull()
  authority.accumulator.note({sources:boundScopeSources(annotation!)})
  const sources=authority.accumulator.evidence.sources??[]
  expect(sources.map(source=>source.resourceKind)).toEqual(expect.arrayContaining(['private_transcript','application_field','session_context_revision']))
  const messages=[
   {role:'assistant',content:[{type:'text',text:'The notebook is still amber.'}]},
   {role:'assistant',content:[{type:'text',text:'The current Memory still says nine.'}]},
  ]
  return{...c,authority,annotation:annotation!,sources,messages}
 }
 it('validates private dialogue directly at each boundary without generic ancestry discovery',async()=>{
  const c=await setup(),authority=await c.fresh()
  const history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const evidence={sources:boundScopeSources(history!)}
  expect(evidence.sources.map(source=>source.resourceKind)).toEqual(['private_transcript'])
  const queries=vi.spyOn(pg.Client.prototype,'query')
  const caller=await validateCallerScopeEvidence(evidence,authority.execution.security.ceiling)
  const recipient=await validateAudienceScopeEvidence(evidence,authority.execution.security.ceiling)
  expect(caller.sources).toEqual(evidence.sources)
  expect(recipient.sources).toEqual(evidence.sources)
  // This is an executed work bound over the real database, not a mocked proof:
  // each operation reads the fresh transcript state and no generic graph.
  expect(queries).toHaveBeenCalledTimes(2)
  for(const call of queries.mock.calls){
   expect(String(call[0])).toContain('read_scope_source($1,t.kind,t.id)')
   expect(call[1]).toEqual([c.f.workspaceId,['private_transcript'],evidence.sources.map(source=>source.resourceId)])
  }
  queries.mockRestore()
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.input.id])
  await expect(validateAudienceScopeEvidence(evidence,authority.execution.security.ceiling))
   .rejects.toMatchObject({diagnostic:'source_held'})
 })
 it.each(['different-actor','application','public-share'] as const)('refuses a private transcript withheld by the non-owner %s reader',async mode=>{
  const c=await setup(),authority=await c.fresh()
  const history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const readerAccess=mode==='different-actor'?(await c.f.modelContext(c.f.secondId)).execution.security.access:authority.execution.security.access
  const client=await getAppPool().connect()
  try{await runWithAgentAccess(readerAccess,async()=>{
   await client.query('BEGIN')
   await applyRLSGucs(client,mode==='different-actor'?c.f.secondId:c.userId)
   if(mode==='application')await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
   if(mode==='public-share')await client.query("SELECT set_config('app.public_share_root',$1,true)",[randomUUID()])
   await expect(validateCallerScopeEvidence({sources:boundScopeSources(history!)},authority.execution.security.ceiling,client))
    .rejects.toMatchObject({diagnostic:'source_unverifiable'})
  })}finally{await client.query('ROLLBACK');client.release()}
 })
 it.each(['caller','audience'] as const)('composes native and dialogue proofs for %s without generic mixed-cohort traversal',async boundary=>{
  const c=await setup(),sources=structuredClone(c.original.accumulator.evidence.sources!)
  const read=nativeEvidence.readConversationEvidence
  const native=vi.spyOn(nativeEvidence,'readConversationEvidence').mockImplementation(async(...args)=>{
   expect(args[2].some(source=>source.resourceKind==='private_transcript')).toBe(true)
   const result=await read(...args)
   expect(result?.kind).toBe('complete')
   return result
  })
  const context={...executionToolContext(c.original.execution,{appId:'fictional-composed-proof'}),scopeAccumulator:c.original.accumulator}
  await (boundary==='caller'?admitModelInput(context):admitModelOutput(context))
  expect(native).toHaveBeenCalledOnce()
  expect(c.original.accumulator.evidence.sources).toEqual(expect.arrayContaining(sources))
 })
 it.each(['caller','audience'] as const)('refuses dialogue withdrawn while the %s native proof is starting',async boundary=>{
  const c=await setup(),read=nativeEvidence.readConversationEvidence
  const native=vi.spyOn(nativeEvidence,'readConversationEvidence').mockImplementation(async(...args)=>{
   // Withdraw before the SQL reader acquires workspace locks. Attempting this
   // after it returns would test a lock timeout, not a completed withdrawal.
   await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.input.id])
   return read(...args)
  })
  const context={...executionToolContext(c.original.execution,{appId:'fictional-composed-proof'}),scopeAccumulator:c.original.accumulator}
  await expect(boundary==='caller'?admitModelInput(context):admitModelOutput(context))
   .rejects.toMatchObject({reason:'authority_changed',cause:{diagnostic:'source_unverifiable'}})
  expect(native).toHaveBeenCalledOnce()
  expect((await c.f.pool.query('SELECT scope_held FROM session_messages WHERE id=$1',[c.input.id])).rows[0].scope_held).toBe(true)
 })
 it('does not promote a database owner into native mixed-source read authority',async()=>{
  const c=await mixedPublication(),client=await c.f.pool.connect()
  try{await runWithAgentAccess(c.authority.execution.security.access,async()=>{
   await client.query('BEGIN')
   await applyRLSGucs(client,c.userId)
   // The owner connection is for maintenance, not an admitted native reader.
   // Source-family composition must preserve that refusal, including fallback.
   await expect(validateCallerScopeEvidence({sources:c.sources},c.authority.execution.security.ceiling,client))
    .rejects.toMatchObject({diagnostic:'source_unverifiable',cause:{code:'42501'}})
  })}finally{await client.query('ROLLBACK');client.release()}
 })
 it.each(['transcript','memory'] as const)('retains every mixed source obligation when %s is held',async held=>{
  const c=await setup(),evidence=c.original.accumulator.evidence
  expect(evidence.sources?.map(source=>source.resourceKind)).toEqual(expect.arrayContaining(['private_transcript','application_field']))
  await audience.admitAttendedAudienceEvidence(c.original.execution,evidence,c.original.execution.security.ceiling,{directHumanSource:true})
  if(held==='transcript')await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.input.id])
  else await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memory.id])
  await expect(audience.admitAttendedAudienceEvidence(c.original.execution,evidence,c.original.execution.security.ceiling,{directHumanSource:true}))
   .rejects.toBeTruthy()
 })
 it('publishes and reads back a private batch with earlier Memory fields and a current context revision',async()=>{
  const c=await mixedPublication()
  const context={...executionToolContext(c.authority.execution,{appId:'fictional-mixed-private-publication'}),scopeAccumulator:c.authority.accumulator}
  await expect(admitModelInput(context)).resolves.toBeUndefined()
  await expect(admitModelOutput(context)).resolves.toBeUndefined()
  const replies=await publishNativeSessionMessageBatch({sessionId:c.session.id,authority:c.authority,derivationTarget:c.scope,
   derivation:{producer:'fixture:mixed-private-publication',sources:c.sources},messages:c.messages})
  expect(replies).toHaveLength(2)
  const history=await readPrivateTranscript(await c.fresh(),c.session.id,replies[1].sequenceNum)
  expect(history?.map(row=>row.id)).toEqual([c.input.id,c.reply.id,...replies.map(row=>row.id)])
  expect(history?.slice(-2).map(row=>row.content)).toEqual(c.messages.map(row=>row.content))
  // Every output references one frame. The frame retains the independently
  // consumed transcript, Memory field and context revision obligations.
  const recorded=(await c.f.pool.query<{resourceId:string;sourceKind:string}>(`SELECT output.resource_id AS "resourceId",input.source_kind AS "sourceKind"
   FROM scope_derivations output JOIN scope_derivation_sources edge ON edge.workspace_id=output.workspace_id AND edge.derivation_id=output.id
   JOIN scope_derivations frame ON frame.workspace_id=edge.workspace_id AND frame.resource_kind=edge.source_kind AND frame.resource_id=edge.source_id
   JOIN scope_derivation_sources input ON input.workspace_id=frame.workspace_id AND input.derivation_id=frame.id
   WHERE output.workspace_id=$1 AND output.resource_kind='session_message' AND output.resource_id=ANY($2::uuid[])`,
   [c.f.workspaceId,replies.map(row=>row.id)])).rows
  for(const reply of replies)expect(recorded.filter(row=>row.resourceId===reply.id).map(row=>row.sourceKind))
   .toEqual(expect.arrayContaining(['private_transcript','application_field','session_context_revision']))
 })
 it.each(['message-hold','message-edit','memory-hold','context-revision-hold'] as const)(
  'rolls back the entire private publication after insert-time %s',async change=>{
   const c=await mixedPublication(),name='fixture_private_pub_'+randomUUID().replaceAll('-','')
   const sequence=name+'_calls',trigger=name+'_insert',fn=name+'_change'
   const readMessages=async()=>(await c.f.pool.query(`SELECT id,role,content,sequence_num,scope_held,scope_version
    FROM session_messages WHERE workspace_id=$1 AND session_id=$2 ORDER BY sequence_num`,[c.f.workspaceId,c.session.id])).rows
   const readDerivations=async()=>(await c.f.pool.query(`SELECT id,resource_kind,resource_id,resource_version
    FROM scope_derivations WHERE workspace_id=$1 ORDER BY id`,[c.f.workspaceId])).rows
   const readEdges=async()=>(await c.f.pool.query(`SELECT derivation_id,source_kind,source_id,source_version
    FROM scope_derivation_sources WHERE workspace_id=$1 ORDER BY derivation_id,source_kind,source_id`,[c.f.workspaceId])).rows
   const readMemory=async()=>(await c.f.pool.query('SELECT summary,scope_held,scope_version FROM memories WHERE workspace_id=$1 AND id=$2',
    [c.f.workspaceId,c.memory.id])).rows
   const readRevision=async()=>(await c.f.pool.query('SELECT scope_held FROM session_context_scope_revisions WHERE workspace_id=$1 AND id=$2',
    [c.f.workspaceId,c.annotation.revisionId])).rows
   const before={messages:await readMessages(),derivations:await readDerivations(),edges:await readEdges(),memory:await readMemory(),revision:await readRevision()}
   const mutation={
    'message-hold':`UPDATE public.session_messages SET scope_held=true WHERE id='${c.input.id}'::uuid;`,
    'message-edit':`UPDATE public.session_messages SET content=jsonb_build_array(jsonb_build_object('type','text','text','Fictional message changed during publication.')) WHERE id='${c.input.id}'::uuid;`,
    'memory-hold':`UPDATE public.memories SET scope_held=true WHERE id='${c.memory.id}'::uuid;`,
    'context-revision-hold':`UPDATE public.session_context_scope_revisions SET scope_held=true WHERE id='${c.annotation.revisionId}'::uuid;`,
   }[change]
   try{
    await c.f.pool.query(`CREATE SEQUENCE public.${sequence}`)
    await c.f.pool.query(`REVOKE ALL ON SEQUENCE public.${sequence} FROM PUBLIC`)
    await c.f.pool.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
     SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN
     IF NEW.session_id='${c.session.id}'::uuid AND NEW.role='assistant' THEN
      PERFORM nextval('public.${sequence}'::regclass);
      ${mutation}
      PERFORM nextval('public.${sequence}'::regclass);
     END IF;RETURN NEW;END $fixture$`)
    await c.f.pool.query(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC`)
    await c.f.pool.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON public.session_messages FOR EACH ROW EXECUTE FUNCTION public.${fn}()`)
    await expect(publishNativeSessionMessageBatch({sessionId:c.session.id,authority:c.authority,derivationTarget:c.scope,
     derivation:{producer:'fixture:insert-time-private-withdrawal',sources:c.sources},messages:c.messages}))
     .rejects.toMatchObject({name:'DerivedScopeError',code:'scope_source_changed'})
    // Sequence increments survive transaction rollback. The second increment
    // proves both SQL insertion and the fixture mutation actually completed.
    const fired=(await c.f.pool.query<{calls:string;called:boolean}>(`SELECT last_value AS calls,is_called AS called FROM public.${sequence}`)).rows[0]
    expect(fired.called).toBe(true)
    expect(Number(fired.calls)).toBeGreaterThanOrEqual(2)
    expect(Number(fired.calls)).toBeLessThanOrEqual(c.messages.length*2)
    expect(await readMessages()).toEqual(before.messages)
    expect(await readDerivations()).toEqual(before.derivations)
    expect(await readEdges()).toEqual(before.edges)
    expect(await readMemory()).toEqual(before.memory)
    expect(await readRevision()).toEqual(before.revision)
   }finally{
    await c.f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON public.session_messages`)
    await c.f.pool.query(`DROP FUNCTION IF EXISTS public.${fn}()`)
    await c.f.pool.query(`DROP SEQUENCE IF EXISTS public.${sequence}`)
   }
  })
 it.each(['transcript','current-message','memory-index','empty-index','immediate-index'] as const)('saves a native Memory from admitted private conversation evidence (%s)',async mode=>{
  const c=await setup(),authority=await c.fresh(),store=createDbMemoryStore()
  const input=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Remember that my fictional notebook is amber.'}],senderUserId:c.userId,scope:c.scope})
  if(mode==='empty-index')await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  if(mode.endsWith('index')){
   const index=await store.getIndex(authority.execution.security.access,false,authority)
   authority.accumulator.note({sources:boundScopeSources(index)})
  }
  const history=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:input.sequenceNum,
   ...(mode!=='transcript'?{currentMessageId:input.id}:{}),authority})
  authority.accumulator.note({sources:boundScopeSources(history)})
  expect(authority.accumulator.evidence.sources?.some(source=>source.resourceKind==='private_transcript')).toBe(true)
  if(mode==='immediate-index'){
   const create=memoryRows.createMemory
   vi.spyOn(memoryRows,'createMemory').mockImplementation(async(params,links,client)=>{
    await client!.query('SET CONSTRAINTS ALL IMMEDIATE')
    return create(params,links,client)
   })
  }
  const tools=createMemoryTools(store),context={...executionToolContext(authority.execution,{appId:'chat'}),scopeAccumulator:authority.accumulator}
  const result=await tools.saveMemory.execute({summary:'The fictional personal notebook is amber.',scope:'user'},context)
  expect(result.isError,JSON.stringify(result)).not.toBe(true)
  authority.accumulator.note(result.scopeEvidence??{})
  await admitModelSourceEvidence(context,'context')
  await admitModelSourceEvidence(context,'deliver')
  // The original input query remains usable for the next write and final reply.
  const again=await tools.saveMemory.execute({summary:'The fictional notebook has a linen cover.',scope:'user'},context)
  expect(again.isError,JSON.stringify(again)).not.toBe(true)
  authority.accumulator.note(again.scopeEvidence??{})
  await publishNativeSessionMessageBatch({sessionId:c.session.id,authority,derivationTarget:c.scope,
   derivation:{producer:'fixture:memory-write-reply',sources:authority.accumulator.evidence.sources??[]},
   messages:[{role:'assistant',content:[{type:'text',text:'Saved both fictional notebook facts.'}]}]})
  expect((await c.f.pool.query('SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1 AND source_session_id=$2',
   [c.f.workspaceId,c.session.id])).rows[0].count).toBe(2)
  const fresh=await c.fresh(),index=await store.getIndex(fresh.execution.security.access,false,fresh)
  expect(index.filter(row=>row.summary.includes('notebook'))).toHaveLength(2)
 })
 it.each(['growth','hold','edit','delete','transcript','device'] as const)('refuses an index-backed Memory write after independent source withdrawal (%s)',async change=>{
  const c=await setup(),authority=await c.fresh(),store=createDbMemoryStore()
  const index=await store.getIndex(authority.execution.security.access,false,authority)
  const history=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:c.reply.sequenceNum,authority})
  authority.accumulator.note({sources:[...boundScopeSources(index),...boundScopeSources(history)]})
  if(change==='growth')await c.f.memory('An unrelated fictional addition.',c.userId)
  if(change==='hold')await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memory.id])
  if(change==='edit')await c.f.pool.query('UPDATE memories SET summary=$2,scope_version=scope_version+1 WHERE id=$1',[c.memory.id,'A changed fictional office fact.'])
  if(change==='delete')await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  if(change==='transcript')await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  if(change==='device')await authSessionStore.revokeForUser(c.userId,c.device.id)
  const before=(await c.f.pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1',[c.f.workspaceId])).rows[0].count
  await expect(createMemoryTools(store).saveMemory.execute({summary:'This refused fictional memory must not survive.',scope:'user'},
   {...executionToolContext(authority.execution,{appId:'chat'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
  expect((await c.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND source_session_id=$2',[c.f.workspaceId,c.session.id])).rows).toHaveLength(0)
  expect((await c.f.pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1',[c.f.workspaceId])).rows[0].count).toBe(before)
 })
 it('does not exempt an output from a different frozen index field selection',async()=>{
  const c=await setup(),store=createDbMemoryStore(),first=await c.fresh(),other=await c.fresh()
  const index=await store.getIndex(first.execution.security.access,false,first)
  const ranked=await store.getIndexRanked!(other.execution.security.access,20,other)
  first.accumulator.note({sources:boundScopeSources(index)})
  other.accumulator.note({sources:boundScopeSources(ranked.rows)})
  for(const authority of [first,other])await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:c.reply.sequenceNum,authority})
  const tools=createMemoryTools(store)
  expect((await tools.saveMemory.execute({summary:'A fictional fact derived from the first index.',scope:'user'},
   {...executionToolContext(first.execution,{appId:'chat'}),scopeAccumulator:first.accumulator})).isError).not.toBe(true)
  await expect(tools.saveMemory.execute({summary:'A fictional fact from the now-stale other projection.',scope:'user'},
   {...executionToolContext(other.execution,{appId:'chat'}),scopeAccumulator:other.accumulator})).rejects.toBeTruthy()
  expect((await c.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND source_session_id=$2',[c.f.workspaceId,c.session.id])).rows).toHaveLength(1)
 })
 it('does not let the runtime role read or forge pending Memory query selectors',async()=>{
  expect((await getAppPool().query(`SELECT has_table_privilege(current_user,'native_memory_query_write_intents','SELECT') AS read,
   has_table_privilege(current_user,'native_memory_query_write_intents','INSERT') AS write,
   has_table_privilege(current_user,'native_memory_query_write_intents','UPDATE') AS update,
   has_table_privilege(current_user,'native_memory_query_write_intents','DELETE') AS delete`)).rows)
   .toEqual([{read:false,write:false,update:false,delete:false}])
  await expect(getAppPool().query('SELECT * FROM native_memory_query_write_intents')).rejects.toMatchObject({code:'42501'})
 })
 it('rolls back tentative Memory lineage when SQL rejects a source after the row insert',async()=>{
  const c=await setup(),authority=await c.fresh(),store=createDbMemoryStore()
  const index=await store.getIndex(authority.execution.security.access,false,authority)
  const history=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:c.reply.sequenceNum,authority})
  authority.accumulator.note({sources:[...boundScopeSources(index),...boundScopeSources(history)]})
  const record=derivedScope.recordDerivedResource
  let reached=false
  vi.spyOn(derivedScope,'recordDerivedResource').mockImplementation(async(client,evidence,output,actor)=>{
   reached=true
   return record(client,{...evidence,sources:evidence.sources.map(source=>source.resourceKind==='private_transcript'
    ?{...source,version:'not-the-observed-version'}:source)},output,actor)
  })
  const before=(await c.f.pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1',[c.f.workspaceId])).rows[0].count
  await expect(createMemoryTools(store).saveMemory.execute({summary:'This late-refused fictional memory must not survive.',scope:'user'},
   {...executionToolContext(authority.execution,{appId:'chat'}),scopeAccumulator:authority.accumulator})).rejects.toMatchObject({code:'scope_source_changed'})
  expect(reached).toBe(true)
  expect((await c.f.pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND source_session_id=$2',[c.f.workspaceId,c.session.id])).rows).toHaveLength(0)
  expect((await c.f.pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1',[c.f.workspaceId])).rows[0].count).toBe(before)
 })
 it.each(['title','state'] as const)('preserves private dialogue and current Memory reads through the %s job wrapper',async kind=>{
  const c=await setup(),fresh=await c.fresh(),signal=new AbortController().signal
  let current=true
  const titleJob={sessionId:c.session.id,workspaceId:c.f.workspaceId,assistantId:c.f.assistantId,actorUserId:c.userId,
   userMessageId:c.input.id,claims:c.claims,authoring:{version:1 as const,assistantId:c.f.assistantId,ceiling:fresh.execution.security.ceiling},
   generation:'1',claimedGeneration:'1',leaseToken:randomUUID(),attempts:1}
  const authority=kind==='title'?restrictTitleJobAuthority(fresh,titleJob,async()=>current,signal)
   :restrictStateJobAuthority(fresh,{...titleJob,assistantMessageId:c.reply.id,firstSequence:1,throughSequence:c.reply.sequenceNum},async()=>current,signal)
  const fallback=vi.spyOn(queryFrames,'readJointSessionQueryFrame')
  const query=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:c.reply.sequenceNum,topicThroughSequence:0,authority})
  expect(query.history.map(row=>row.id)).toEqual([c.input.id,c.reply.id])
  expect(boundScopeSources(query).map(source=>source.resourceKind)).toEqual(['private_transcript'])
  expect(fallback).not.toHaveBeenCalled()
  // The credential handoff changes neither Memory retrieval nor its current-source obligations.
  const memory=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
  expect(JSON.stringify(memory)).toContain('The fictional office currently opens at nine.')
  expect(boundScopeSources(memory).some(source=>source.resourceKind==='application_field')).toBe(true)
  await admitModelInput({...executionToolContext(authority.execution,{appId:'fixture:job-dialogue-memory'}),scopeAccumulator:authority.accumulator})
  const [reply]=await publishNativeSessionMessageBatch({sessionId:c.session.id,authority,derivationTarget:c.scope,
   derivation:{producer:'fixture:job-dialogue-memory',sources:authority.accumulator.evidence.sources??[]},
   messages:[{role:'assistant',content:[{type:'text',text:'We still chose the amber notebook; the current Memory says nine.'}]}]})
  expect(reply.sequenceNum).toBe(c.reply.sequenceNum+1)
  current=false
  await expect(readPrivateTranscript(authority,c.session.id,reply.sequenceNum)).rejects.toThrow(`${kind}_job_changed`)
 })
 it.each(['edit','delete','hold','growth'])('remembers prior dialogue after source %s and can publish the next reply',async change=>{
  const c=await setup()
  if(change==='edit')await c.f.pool.query('UPDATE memories SET summary=$2,scope_version=scope_version+1 WHERE id=$1',[c.memory.id,'Office now opens at ten.'])
  if(change==='delete')await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  if(change==='hold')await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memory.id])
  if(change==='growth')await c.f.memory('An unrelated fictional fact.',c.userId)
  await expect(admitModelInput({...executionToolContext(c.original.execution,{appId:'fictional-stale-facts'}),
   scopeAccumulator:c.original.accumulator})).rejects.toBeTruthy()
  const next=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Which notebook did we choose?'}],senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh(),history=(await readAttendedSessionHistory(authority,c.session.id)).messages
  expect(history.map(row=>row.id)).toEqual([c.input.id,c.reply.id,next.id])
  expect(JSON.stringify(history)).toContain('amber notebook')
  const context={...executionToolContext(authority.execution,{appId:'fictional-continuation'}),scopeAccumulator:authority.accumulator}
  await admitModelInput(context)
  await admitModelOutput(context)
  const [continued]=await publishNativeSessionMessageBatch({sessionId:c.session.id,authority,derivationTarget:c.scope,
   derivation:{producer:'fixture:continuation',sources:authority.accumulator.evidence.sources??[]},
   messages:[{role:'assistant',content:[{type:'text',text:'We chose the amber notebook.'}]}]})
  expect(((await readAttendedSessionHistory(await c.fresh(),c.session.id)).messages).map(row=>row.id)).toContain(continued.id)
 })
 legacyUpload('admits current uploaded content independently while keeping earlier dialogue as utterances',async()=>{
  const c=await setup()
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  const content=[{type:'text',text:'Read <attached_file id="fictional" name="notes.txt" type="text/plain">FRESH_FILE_BODY</attached_file>'},
   {type:'image',mimeType:'image/png',data:'YWJj'}]
  const current=await addSessionMessage({sessionId:c.session.id,role:'user',content,senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh()
  const query=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:current.sequenceNum,currentMessageId:current.id,authority})
  expect(query.history.find(row=>row.id===current.id)?.content).toEqual(content)
  expect(query.history.find(row=>row.id===c.reply.id)?.content).toEqual([{type:'text',text:'We chose the amber notebook. The office opens at nine.'}])
  expect(boundScopeSources(query).some(source=>source.resourceKind==='session_message'&&source.resourceId===current.id)).toBe(true)
  await admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-current-upload'}),scopeAccumulator:authority.accumulator})
  const followup=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'What did the attached file say?'}],senderUserId:c.userId,scope:c.scope})
  const later=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:followup.sequenceNum,currentMessageId:followup.id,authority:await c.fresh()})
  const historicalUpload=JSON.stringify(later.history.find(row=>row.id===current.id)?.content)
  expect(historicalUpload).toContain('notes.txt')
  expect(historicalUpload).toContain('fictional')
  expect(historicalUpload).not.toContain('FRESH_FILE_BODY')
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[current.id])
  await expect(admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-current-upload'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
 })
 legacyUpload.each([true,false])('preserves the active upload when new messages force classified history recapture (header: %s)',async header=>{
  const c=await setup()
  const content=[...(header?[{type:'text',text:'<attached_file id="upload" name="scan.png" type="image/png">[image]</attached_file>'}]:[]),
   {type:'image',mimeType:'image/png',data:'YWJj'}]
  const current=await addSessionMessage({sessionId:c.session.id,role:'user',content,senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh()
  const capture=await captureAttendedSessionClassification({authority,session:c.session,message:current})
  const provider:LLMProvider={name:'fictional-classification',models:['fixture'],createSession(){throw new Error('Unexpected session')},
   stream:async function*(){yield{type:'text_delta',text:JSON.stringify({topic_label:'Upload',state:'continue',confidence:0.9,related_topics:[]})}}}
  const assessment=await assessAttendedSessionMessage({authority,session:c.session,message:current,provider,model:'fixture',capture})
  const classified=await assessment.defer()
  const later=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'An additional note.'}],senderUserId:c.userId,scope:c.scope})
  const history=(await classified.readHistory(authority)).messages
  expect(history.find(row=>row.id===current.id)?.content).toEqual(content)
  expect(history.map(row=>row.id)).toContain(later.id)
  expect(history.findIndex(row=>row.id===current.id)).toBeLessThan(history.findIndex(row=>row.id===later.id))
  await admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-recaptured-upload'}),scopeAccumulator:authority.accumulator})
 })
 it('works for an ordinary member who owns their conversation',async()=>{
  const c=await setup(true);await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  expect(((await readAttendedSessionHistory(await c.fresh(),c.session.id)).messages).map(row=>row.id)).toContain(c.reply.id)
 })
 it.each(['unchanged','device','membership','message-edit','message-hold'] as const)(
  'releases capture locks and pool capacity before its final live check (%s)',async change=>{
   const c=await setup(),authority=await c.fresh(),pool=getAppPool()
   const lease=await takeTurnLease({sessionId:c.session.id,admission:'personal',assistantId:c.f.assistantId})
   if(!lease.taken)throw new Error('Fixture turn was not admitted')
   const held:Array<{release:()=>void}>=[]
   const note=vi.spyOn(authority.accumulator,'note')
   const before=structuredClone(authority.accumulator.evidence)
   const current=authority.execution.security.authority.assertCurrent.bind(authority.execution.security.authority)
   let finish!:()=>void,paused=false,checks=0
   const resume=new Promise<void>(resolve=>{finish=resolve})
   // Source withdrawal after the live metadata read must still fail actual
   // model admission. Credential withdrawal happens before that metadata read.
   const sourceChange=change==='message-edit'||change==='message-hold'
   vi.spyOn(authority.execution.security.authority,'assertCurrent').mockImplementation(async()=>{
    const captureReturn=++checks===2
    if(captureReturn&&!sourceChange){paused=true;await resume}
    await current()
    if(captureReturn&&sourceChange){paused=true;await resume}
   })
   let pending:ReturnType<typeof readPrivateTranscript>|undefined
   let outcome:Promise<{rows:Awaited<ReturnType<typeof readPrivateTranscript>>;error?:never}|{error:unknown;rows?:never}>|undefined
   let poolProbe:Promise<void>|undefined
   let heartbeat:ReturnType<typeof storedSessions.touchTurnLease>|undefined
   let probes:Promise<PromiseSettledResult<unknown>[]>|undefined
   try{
    // Leave exactly one application slot for capture. A second checkout can
    // finish while the lease check is paused only after capture releases it.
    for(let slot=1;slot<(pool.options.max??10);slot++)held.push(await pool.connect())
    pending=readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
    outcome=pending.then(rows=>({rows}),error=>({error}))
    await expect.poll(()=>paused,{timeout:5000}).toBe(true)
    let poolAvailable=false,heartbeatFinished=false
    poolProbe=pool.connect().then(client=>{client.release();poolAvailable=true})
    heartbeat=storedSessions.touchTurnLease(c.session.id,lease.token).then(value=>{heartbeatFinished=true;return value})
    probes=Promise.allSettled([poolProbe,heartbeat])
    await expect.poll(()=>poolAvailable&&heartbeatFinished,{timeout:1000}).toBe(true)
    await poolProbe
    expect(await heartbeat).toEqual({held:true,cancelRequested:false})
    expect(note).not.toHaveBeenCalled()
    if(change==='device')await authSessionStore.revokeForUser(c.userId,c.device.id)
    if(change==='membership')await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[c.f.workspaceId,c.userId])
    if(change==='message-edit')await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[c.reply.id,JSON.stringify([{type:'text',text:'A changed fictional utterance.'}])])
    if(change==='message-hold')await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
    finish()
    const result=await outcome
    if(change==='device'||change==='membership'){
     expect(result.error).toMatchObject({reason:'authority_changed'})
     expect(note).not.toHaveBeenCalled()
     expect(authority.accumulator.evidence).toEqual(before)
    }else{
     expect(result.error).toBeUndefined()
     expect(result.rows?.map(row=>row.id)).toEqual([c.input.id,c.reply.id])
     const admission=admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-capture-return'}),scopeAccumulator:authority.accumulator})
     if(sourceChange)await expect(admission).rejects.toBeTruthy()
     else await expect(admission).resolves.toBeUndefined()
    }
   }finally{
    finish()
    await outcome
    // Free reserved slots even on the old implementation's failed probe, then
    // drain every pending checkout/update before fixture teardown.
    for(const client of held)client.release()
    await probes
    await releaseTurn(c.session.id,lease.token,'completed')
   }
  },60_000)
 it('invalidates captured dialogue after a direct message hold',async()=>{
  const c=await setup(),authority=await c.fresh()
  const history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  expect(history?.map(row=>row.id)).toContain(c.reply.id)
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  await expect(admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-hold'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
 })
 it('rechecks the complete dialogue and native cohort on every chunk',async()=>{
  const c=await setup(),authority=await c.fresh()
  await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const index=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
  authority.accumulator.note({sources:boundScopeSources(index)})
  expect(authority.accumulator.evidence.sources?.some(source=>source.resourceKind==='application_field')).toBe(true)
  const admit=vi.spyOn(audience,'admitAttendedAudienceEvidence')
  const delivery=createTurnDeliveryAdmission(authority.execution,authority.accumulator,c.session)!
  const context={...executionToolContext(authority.execution,{appId:'fictional-streaming-dialogue'}),scopeAccumulator:authority.accumulator}
  await assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})
  const initial=admit.mock.calls.length
  for(let chunk=0;chunk<5;chunk++)await assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})
  expect(admit.mock.calls.slice(initial)).toHaveLength(5)
  for(const call of admit.mock.calls.slice(initial))expect(call[1].sources?.map(source=>source.resourceKind))
   .toEqual(expect.arrayContaining(['private_transcript','application_field']))
  // The first event must also validate the ordinary current sources.
  expect(admit.mock.calls.slice(0,initial).some(call=>call[1].sources?.some(source=>source.resourceKind==='application_field'))).toBe(true)
 })
 it.each([false,true])('releases transcript locks between events and observes withdrawal during native admission (withdraw=%s)',async withdraw=>{
  const c=await setup(),authority=await c.fresh()
  await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const index=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
  authority.accumulator.note({sources:boundScopeSources(index)})
  const lease=await takeTurnLease({sessionId:c.session.id,admission:'personal',assistantId:c.f.assistantId})
  if(!lease.taken)throw new Error('Fixture turn was not admitted')
  const delivery=createTurnDeliveryAdmission(authority.execution,authority.accumulator,c.session)!
  const context={...executionToolContext(authority.execution,{appId:'fictional-heartbeat'}),scopeAccumulator:authority.accumulator}
  await assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})
  // A distinct, still valid transcript capture changes the evidence footprint.
  await readPrivateTranscript(authority,c.session.id,c.input.sequenceNum)
  let entered!:()=>void,finish!:()=>void
  const enteredNative=new Promise<void>(resolve=>{entered=resolve}),resume=new Promise<void>(resolve=>{finish=resolve})
  const original=audience.admitAttendedAudienceEvidence
  vi.spyOn(audience,'admitAttendedAudienceEvidence').mockImplementation(async(...args)=>{
   entered();await resume
   return original(...args)
  })
  const pending=assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})
  // Attach the rejection observer before opening the controlled race.
  const outcome=withdraw?expect(pending).rejects.toBeTruthy():expect(pending).resolves.toBeUndefined()
  let tick:ReturnType<typeof storedSessions.touchTurnLease>|undefined
  try{
   await Promise.race([enteredNative,pending.then(()=>{throw new Error('Missing canonical admission interception')})])
   // A leaked FOR SHARE transcript lock would block the production heartbeat
   // writer until the paused delivery resumes. It must finish independently.
   let finished=false
   tick=storedSessions.touchTurnLease(c.session.id,lease.token).then(value=>{finished=true;return value})
   await expect.poll(()=>finished,{timeout:1000}).toBe(true)
   expect(await tick).toEqual({held:true,cancelRequested:false})
   if(withdraw)await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  }finally{finish();await outcome;await tick;await releaseTurn(c.session.id,lease.token,'completed')}
 })
 it.each(['edit','delete','message-hold','membership','device','recording'])('refuses current transcript authority withdrawal: %s',async change=>{
  const c=await setup(),authority=await c.fresh()
  await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const delivery=createTurnDeliveryAdmission(authority.execution,authority.accumulator,c.session)!
  const context={...executionToolContext(authority.execution,{appId:'fictional-live-dialogue'}),scopeAccumulator:authority.accumulator}
  await assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})
  if(change==='edit')await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[c.reply.id,JSON.stringify([{type:'text',text:'Edited utterance'}])])
  if(change==='delete')await c.f.pool.query('DELETE FROM session_messages WHERE id=$1',[c.reply.id])
  if(change==='message-hold')await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  if(change==='membership')await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[c.f.workspaceId,c.userId])
  if(change==='device')await authSessionStore.revokeForUser(c.userId,c.device.id)
  if(change==='recording')await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[c.session.id])
  await expect(assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})).rejects.toBeTruthy()
  await expect(assertModelOutputAuthority({...context,admitModelOutput:delivery.authorizeDelivery})).rejects.toBeTruthy()
  await expect(admitModelInput({...executionToolContext(authority.execution,{appId:'fictional-withdrawal'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
 })
 it('keeps captures bounded, deduplicated and unavailable to direct app-role writes',async()=>{
  const c=await setup(),one=await readPrivateTranscript(await c.fresh(),c.session.id,c.input.sequenceNum)
  expect(one?.map(row=>row.id)).toEqual([c.input.id])
  const two=await readPrivateTranscript(await c.fresh(),c.session.id,c.input.sequenceNum)
  expect(boundScopeSources(two!)).toEqual(boundScopeSources(one!))
  await expect(getAppPool().query('SELECT * FROM private_transcript_observations')).rejects.toMatchObject({code:'42501'})
  await expect(getPool().query('SELECT capture_private_transcript($1,$2,$3,$4,$5)',
   [c.f.workspaceId,c.session.id,c.device.id,c.device.authVersion,c.reply.sequenceNum])).rejects.toMatchObject({code:'42501'})
 })
 it('does not grant another member access to the private transcript source',async()=>{
  const c=await setup(),authority=await c.fresh(),history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  const other=await c.f.modelContext(c.f.firstId)
  other.accumulator=new ContextScopeAccumulator({sources:boundScopeSources(history!)})
  await expect(admitModelInput({...executionToolContext(other.execution,{appId:'fictional-foreign-reader'}),scopeAccumulator:other.accumulator})).rejects.toBeTruthy()
 })
 it('rebuilds and persists an obsolete summary using the existing cursor without importing old source authority',async()=>{
  const c=await setup()
  await setCompactSummaryAndBoundary(c.session.id,'Obsolete source-derived summary.',c.reply.sequenceNum,null,
   {authority:c.original,derivation:{producer:'fixture:old-summary',sources:c.original.accumulator.evidence.sources??[]}})
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  await expect(readCompactSummary(c.session.id,await c.fresh())).rejects.toMatchObject({code:'scope_source_changed'})
  const next=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Continue our notebook discussion.'}],senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh(),session=(await findSessionById(c.session.id))!
  const history=(await readAttendedSessionHistory(authority,c.session.id,session.compactBoundarySequence)).messages
  const calls:Message[][]=[]
  const provider:LLMProvider={name:'fictional-summary',models:['fixture'],createSession(){throw new Error('Unexpected session')},
   stream:async function*(options){calls.push(structuredClone(options.messages));yield{type:'text_delta',text:'The user chose the amber notebook.'}}}
  const result=await runProactiveCompaction({session,sessionMessages:history,timezone:'UTC',tier:'standard',channelClass:'messaging',profile:'linear',
   provider,systemPrompt:'Summarize the fictional dialogue.',assistantId:c.f.assistantId,userId:c.userId,ownerId:c.userId,channelType:'web',
   memoryStore:createDbMemoryStore(),unconditional:true,persistLongTermContext:false,persistSessionSummary:true,
   authority:authority.execution.security.authority,modelContext:authority})
  expect(result.compacted).toBe(true)
  expect(JSON.stringify(calls)).toContain('Remember that we chose the amber notebook.')
  expect(JSON.stringify(calls)).not.toContain('Obsolete source-derived summary.')
  const summary=await readCompactSummary(c.session.id,await c.fresh())
  expect(summary?.summary).toContain('amber notebook')
  expect(summary?.boundarySequence).toBe(next.sequenceNum)
 },120_000)
 it.each(['ordinary','greeting','retry','channel-retry','compacted','history-timeout','summary-timeout'])('passes old dialogue to the actual web provider: %s',async mode=>{
  const compacted=mode==='compacted'||mode==='summary-timeout'
  const c=await setup()
  if(compacted)expect(await setCompactSummaryAndBoundary(c.session.id,'The office opens at nine; amber notebook selected.',c.reply.sequenceNum,null,
   {authority:c.original,derivation:{producer:'fixture:old-summary',sources:c.original.accumulator.evidence.sources??[]}})).not.toBeNull()
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  await c.f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[c.f.workspaceId])
  if(mode==='summary-timeout'){
   const original=storedSessions.readCompactSummary
   vi.spyOn(storedSessions,'readCompactSummary').mockImplementation((id,authority)=>{
    if(id===c.session.id)throw Object.assign(new Error('fictional_old_summary_timeout'),{code:'57014'})
    return original(id,authority)
   })
  }
  if(mode==='history-timeout'){
   const original=queryFrames.readJointSessionQueryFrame
   vi.spyOn(queryFrames,'readJointSessionQueryFrame').mockImplementation((authority,roots,selection)=>{
    if(selection.sessionId===c.session.id)throw Object.assign(new Error('fictional_old_history_timeout'),{code:'57014'})
    return original(authority,roots,selection)
   })
  }
  const calls:Message[][]=[]
  const chunks=(text:string):StreamChunk[]=>[{type:'message_start',model:'fixture'},
   {type:'thinking_delta',text:'Considering the conversation.'},
   ...text.split(' ').map((word,index)=>({type:'text_delta' as const,text:(index?' ':'')+word})),
   {type:'message_end',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}}]
  const provider:LLMProvider={name:'fictional-continuity',models:['fixture'],
   stream:async function*(){yield* chunks('Fictional notebook discussion')},
   createSession(){return{send(messages){calls.push(structuredClone(messages));return(async function*(){yield* chunks('We chose the amber notebook.')})()}}}}
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
   req.userId=c.userId;req.authSessionId=c.device.id;req.authVersion=c.device.authVersion;next()
  })
  app.use('/chat',chatRoutes({provider,systemPrompt:'Continue the fictional private conversation.',tools:new Map(),
   memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
  const replay=mode==='retry'||mode==='channel-retry'
  const resume=vi.spyOn(privateTranscripts,'resumePrivateLegacySession')
  const failedInput=replay?await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'hi?'}],senderUserId:c.userId,scope:c.scope}):undefined
  const target=mode==='channel-retry'?{channelId:c.session.channelId}:{sessionId:c.session.id}
  const response=await request(app).post('/chat').send({...target,assistantId:c.f.assistantId,workspaceId:c.f.workspaceId,
   ...(failedInput?{truncateFromMessageId:failedInput.id}:{}),
   message:mode==='greeting'||replay?'hi?':'Which notebook did we choose earlier?',mode:'default',model:'pro'})
  expect(response.status,response.text).toBe(200)
  expect(response.text).not.toContain('event: error')
  expect(resume).not.toHaveBeenCalled()
  expect(calls.length,response.text).toBeGreaterThan(0)
  expect(JSON.stringify(calls[0])).toContain('We chose the amber notebook. The office opens at nine.')
  const history=(await readAttendedSessionHistory(await c.fresh(),c.session.id)).messages
  expect(history.at(-1)?.content).toEqual([{type:'text',text:'We chose the amber notebook.'}])
  if(failedInput){
   expect(history.map(row=>row.id)).not.toContain(failedInput.id)
   expect(history.map(row=>row.id)).toContain(c.reply.id)
   const replacement=history.at(-2)!
   const replayed=await request(app).post('/chat').send({...target,assistantId:c.f.assistantId,workspaceId:c.f.workspaceId,
    truncateFromMessageId:replacement.id,message:'hi?',mode:'default',model:'pro'})
   expect(replayed.text).not.toContain('event: error')
   expect(resume).not.toHaveBeenCalled()
   const after=(await readAttendedSessionHistory(await c.fresh(),c.session.id)).messages
   expect(after.map(row=>row.id)).not.toContain(replacement.id)
   expect(after.map(row=>row.id)).toContain(c.reply.id)
   expect(after.at(-1)?.content).toEqual([{type:'text',text:'We chose the amber notebook.'}])
  }
 },120_000)

 it('claims before preparation, rejects a competing send and accepts Stop before provider dispatch',async()=>{
  const c=await setup()
  await c.f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[c.f.workspaceId])
  const memoryStore=createDbMemoryStore(),read=memoryStore.getPairedPromptIndexes!.bind(memoryStore)
  let entered=false,release!:()=>void
  const waiting=new Promise<void>(resolve=>{release=resolve})
  const preparation=vi.fn(async(...args:Parameters<typeof read>)=>{
   entered=true;await waiting;return read(...args)
  })
  memoryStore.getPairedPromptIndexes=preparation
  const modelCalls:Message[][]=[]
  const provider:LLMProvider={name:'fictional-preparation',models:['fixture'],
   stream:async function*(){yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional topic'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}},
   createSession(){return{send(messages){modelCalls.push(structuredClone(messages));return(async function*(){yield{type:'message_start' as const,model:'fixture'};yield{type:'text_delta' as const,text:'Fictional reply'};yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}})()}}}}
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
   req.userId=c.userId;req.authSessionId=c.device.id;req.authVersion=c.device.authVersion;next()
  })
  app.use('/chat',chatRoutes({provider,systemPrompt:'Fictional preparation.',tools:new Map(),memoryStore,
   capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
  const payload={sessionId:c.session.id,assistantId:c.f.assistantId,workspaceId:c.f.workspaceId,message:'Continue with the notebook.',mode:'default',model:'pro'}
  const first=request(app).post('/chat').send(payload).then(response=>response)
  try{
   await vi.waitFor(()=>expect(entered).toBe(true),{timeout:15_000})
   const active=(await c.f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[c.session.id])).rows[0]
   expect(active.status).toBe('running');expect(active.turn_lease_token).not.toBeNull()
   const second=await request(app).post('/chat').send({...payload,message:'Competing send.'})
   expect(second.text).toContain('turn_in_flight')
   expect(preparation).toHaveBeenCalledTimes(1)
   const stopped=await request(app).post('/chat/stop').send({sessionId:c.session.id})
   expect(stopped.body).toMatchObject({stopped:true,via:'aborted'})
  }finally{release();await first}
  expect(modelCalls).toEqual([])
  const settled=(await c.f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[c.session.id])).rows[0]
  expect(settled.status).not.toBe('running');expect(settled.turn_lease_token).toBeNull()
 },120_000)

})
