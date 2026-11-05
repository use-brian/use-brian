import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import type {LLMProvider,Message,StreamChunk} from '@use-brian/core'
import {chatRoutes} from '../../routes/chat.js'
import {runProactiveCompaction} from '../../routes/proactive-compaction.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../db/pending-approvals-store.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession,setCompactSummaryAndBoundary,readCompactSummary,findSessionById} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {readPrivateTranscript} from '../../db/private-transcript.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/private-transcript] ordinary private conversation continuity',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
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
  expect(boundScopeSources(query).some(source=>source.resourceKind==='private_transcript')).toBe(false)
  const memories=await createDbMemoryStore().getIndex(original.execution.security.access,false,original)
  original.accumulator.note({sources:[...boundScopeSources(query),...boundScopeSources(memories)]})
  const [reply]=await publishNativeSessionMessageBatch({sessionId:session.id,authority:original,derivationTarget:scope,
   derivation:{producer:'fixture:conversation',sources:[...boundScopeSources(query),...boundScopeSources(memories)]},
   messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'We chose the amber notebook. The office opens at nine.'}]}]})
  return{f,session,scope,input,reply,memory,fresh,claims,userId,device,original}
 }
 it.each(['edit','delete','hold','growth'])('remembers prior dialogue after source %s and can publish the next reply',async change=>{
  const c=await setup()
  if(change==='edit')await c.f.pool.query('UPDATE memories SET summary=$2,scope_version=scope_version+1 WHERE id=$1',[c.memory.id,'Office now opens at ten.'])
  if(change==='delete')await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  if(change==='hold')await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memory.id])
  if(change==='growth')await c.f.memory('An unrelated fictional fact.',c.userId)
  await expect(assertSourceModelInputAuthority({...executionToolContext(c.original.execution,{appId:'fictional-stale-facts'}),
   scopeAccumulator:c.original.accumulator})).rejects.toBeTruthy()
  const next=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Which notebook did we choose?'}],senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh(),history=await readAttendedSessionHistory(authority,c.session.id)
  expect(history.map(row=>row.id)).toEqual([c.input.id,c.reply.id,next.id])
  expect(JSON.stringify(history)).toContain('amber notebook')
  const context={...executionToolContext(authority.execution,{appId:'fictional-continuation'}),scopeAccumulator:authority.accumulator}
  await assertSourceModelInputAuthority(context)
  await assertSourceModelOutputAuthority(context)
  const [continued]=await publishNativeSessionMessageBatch({sessionId:c.session.id,authority,derivationTarget:c.scope,
   derivation:{producer:'fixture:continuation',sources:authority.accumulator.evidence.sources??[]},
   messages:[{role:'assistant',content:[{type:'text',text:'We chose the amber notebook.'}]}]})
  expect((await readAttendedSessionHistory(await c.fresh(),c.session.id)).map(row=>row.id)).toContain(continued.id)
 })
 it('works for an ordinary member who owns their conversation',async()=>{
  const c=await setup(true);await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  expect((await readAttendedSessionHistory(await c.fresh(),c.session.id)).map(row=>row.id)).toContain(c.reply.id)
 })
 it('invalidates captured dialogue after a direct message hold',async()=>{
  const c=await setup(),authority=await c.fresh()
  const history=await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  expect(history?.map(row=>row.id)).toContain(c.reply.id)
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fictional-hold'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
 })
 it.each(['edit','delete','membership','device','recording'])('refuses current transcript authority withdrawal: %s',async change=>{
  const c=await setup(),authority=await c.fresh()
  await readPrivateTranscript(authority,c.session.id,c.reply.sequenceNum)
  if(change==='edit')await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[c.reply.id,JSON.stringify([{type:'text',text:'Edited utterance'}])])
  if(change==='delete')await c.f.pool.query('DELETE FROM session_messages WHERE id=$1',[c.reply.id])
  if(change==='membership')await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[c.f.workspaceId,c.userId])
  if(change==='device')await authSessionStore.revokeForUser(c.userId,c.device.id)
  if(change==='recording')await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[c.session.id])
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fictional-withdrawal'}),scopeAccumulator:authority.accumulator})).rejects.toBeTruthy()
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
  await expect(assertSourceModelInputAuthority({...executionToolContext(other.execution,{appId:'fictional-foreign-reader'}),scopeAccumulator:other.accumulator})).rejects.toBeTruthy()
 })
 it('rebuilds and persists an obsolete summary using the existing cursor without importing old source authority',async()=>{
  const c=await setup()
  await setCompactSummaryAndBoundary(c.session.id,'Obsolete source-derived summary.',c.reply.sequenceNum,null,
   {authority:c.original,derivation:{producer:'fixture:old-summary',sources:c.original.accumulator.evidence.sources??[]}})
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  await expect(readCompactSummary(c.session.id,await c.fresh())).rejects.toMatchObject({code:'scope_source_changed'})
  const next=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Continue our notebook discussion.'}],senderUserId:c.userId,scope:c.scope})
  const authority=await c.fresh(),session=(await findSessionById(c.session.id))!
  const history=await readAttendedSessionHistory(authority,c.session.id,session.compactBoundarySequence)
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
 it.each([false,true])('passes old dialogue to the actual web provider, including obsolete summary recovery: %s',async compacted=>{
  const c=await setup()
  if(compacted)expect(await setCompactSummaryAndBoundary(c.session.id,'The office opens at nine; amber notebook selected.',c.reply.sequenceNum,null,
   {authority:c.original,derivation:{producer:'fixture:old-summary',sources:c.original.accumulator.evidence.sources??[]}})).not.toBeNull()
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory.id])
  await c.f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[c.f.workspaceId])
  const calls:Message[][]=[]
  const chunks=(text:string):StreamChunk[]=>[{type:'message_start',model:'fixture'},{type:'text_delta',text},
   {type:'message_end',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}}]
  const provider:LLMProvider={name:'fictional-continuity',models:['fixture'],
   stream:async function*(){yield* chunks('Fictional notebook discussion')},
   createSession(){return{send(messages){calls.push(structuredClone(messages));return(async function*(){yield* chunks('We chose the amber notebook.')})()}}}}
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
   req.userId=c.userId;req.authSessionId=c.device.id;req.authVersion=c.device.authVersion;next()
  })
  app.use('/chat',chatRoutes({provider,systemPrompt:'Continue the fictional private conversation.',tools:new Map(),
   memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
  const response=await request(app).post('/chat').send({sessionId:c.session.id,assistantId:c.f.assistantId,workspaceId:c.f.workspaceId,
   message:'Which notebook did we choose earlier?',mode:'default',model:'pro'})
  expect(response.status,response.text).toBe(200)
  expect(response.text).not.toContain('event: error')
  expect(calls.length,response.text).toBeGreaterThan(0)
  expect(JSON.stringify(calls[0])).toContain('We chose the amber notebook. The office opens at nine.')
  expect((await readAttendedSessionHistory(await c.fresh(),c.session.id)).at(-1)?.content).toEqual([{type:'text',text:'We chose the amber notebook.'}])
 },120_000)

})
