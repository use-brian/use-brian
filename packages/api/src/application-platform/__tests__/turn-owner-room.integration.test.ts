/** [COMP:api/turn-kernel] Real room input survives owner admission and Stop. */
import express from 'express'
import request from 'supertest'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import type {LLMProvider, Message} from '@use-brian/agent-runtime/providers/types.js'
import {chatRoutes} from '../../routes/chat.js'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../db/pending-approvals-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{vi.restoreAllMocks();await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe.sequential('room turn owner',()=>{
 it('persists a silent room post without preparing any model or claiming a turn',async()=>{
  f=await persistentContextFixture('confidential'); const fixture=f
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional earlier human note.'}],
   senderUserId:f.secondId,scope:f.envelope})
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional silent browser',userAgent:null,ipAddress:null}))!
  const resolveWorkspaceCustomLlm=vi.fn(async()=>null),dispatch=vi.fn(()=>{throw new Error('A silent post must not prepare or dispatch inference')})
  const provider:LLMProvider={name:'fictional-silent',models:[],stream:dispatch,createSession:dispatch}
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=fixture.ownerId;req.authSessionId=device.id;req.authVersion=device.authVersion;next()})
  app.use('/chat',chatRoutes({provider,resolveWorkspaceCustomLlm,systemPrompt:'Fictional silent post.',tools:new Map(),memoryStore:createDbMemoryStore(),
   capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()} as never))
  const response=await request(app).post('/chat').send({sessionId:f.session.id,assistantId:f.assistantId,workspaceId:f.workspaceId,message:'Fictional shared note.',mode:'default',model:'pro'})
  expect(response.status).toBe(200);expect(response.text).toContain('event: posted');expect(response.text).not.toContain('event: error')
  expect(resolveWorkspaceCustomLlm).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled()
  const session=(await f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0]
  expect(session.turn_lease_token).toBeNull();expect(session.status).not.toBe('running')
  expect(JSON.stringify((await f.pool.query("SELECT content FROM session_messages WHERE session_id=$1 AND role='user'",[f.session.id])).rows)).toContain('Fictional shared note.')
 },60_000)
 it.each(['queued','steered','disconnected'] as const)('preserves a %s durable post across active preparation',async mode=>{
  f=await persistentContextFixture('confidential');const fixture=f,session=f.session
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional room browser',userAgent:null,ipAddress:null}))!
  const memoryStore=createDbMemoryStore(),read=memoryStore.getIndexRanked.bind(memoryStore)
  const resolveWorkspaceCustomLlm=vi.fn(async()=>null)
  let entered=false,release!:()=>void
  const waiting=new Promise<void>(resolve=>{release=resolve})
  vi.spyOn(memoryStore,'getIndexRanked').mockImplementation(async(...args)=>{entered=true;await waiting;return read(...args)})
  let finishedRequests=0
  const calls:Message[][]=[]
  const provider:LLMProvider={name:'fictional-room-owner',models:['fixture'],
   stream:async function*(){yield{type:'text_delta',text:'Fictional room discussion'}},
   createSession(){return{send(messages){calls.push(structuredClone(messages));return(async function*(){
    yield{type:'message_start' as const,model:'fixture'};yield{type:'text_delta' as const,text:'The room note is retained.'}
    yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
   })()}}}}
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
   req.userId=fixture.ownerId;req.authSessionId=device.id;req.authVersion=device.authVersion;next()
  })
  app.use('/chat',chatRoutes({provider,resolveWorkspaceCustomLlm,systemPrompt:'Fictional room owner test.',tools:new Map(),memoryStore,
   capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore(),
   analytics:{logEvent:(event:{eventName:string})=>{if(event.eventName==='turn_timings')finishedRequests++}} as never}))
  const payload={sessionId:session.id,assistantId:f.assistantId,workspaceId:f.workspaceId,message:'Discuss the amber notebook.',mode:'default',model:'pro'}
  const first=request(app).post('/chat').send(payload).then(response=>response)
  let second:Promise<unknown>|undefined,body=''
  try{
   await vi.waitFor(()=>expect(entered).toBe(true),{timeout:15_000})
   expect(resolveWorkspaceCustomLlm).toHaveBeenCalledTimes(1) // only the acquired turn's background lane
   const pending=request(app).post('/chat').send({...payload,message:'Keep the violet room note.',midTurn:mode==='steered',steer:mode==='steered'})
    .buffer(true).parse((res,done)=>{res.on('data',(chunk:Buffer)=>{body+=chunk.toString()});res.on('end',()=>done(null,body));res.on('error',done)})
   second=pending.then(response=>{expect(response.status).toBe(200);return response},error=>{if(mode!=='disconnected')throw error})
   await vi.waitFor(()=>expect(body).toContain(mode==='steered'?'event: input_queued':'event: queued'),{timeout:15_000})
   const posted=(await f.pool.query("SELECT content FROM session_messages WHERE session_id=$1 AND role='user' ORDER BY sequence_num",[session.id])).rows
   expect(JSON.stringify(posted)).toContain('Keep the violet room note.')
   expect(calls).toHaveLength(0)
   expect(resolveWorkspaceCustomLlm).toHaveBeenCalledTimes(1) // queued/steered posts have no model preparation
   if(mode==='disconnected')pending.abort()
   if(mode==='queued')expect((await request(app).post('/chat/stop').send({sessionId:session.id})).body).toMatchObject({stopped:true,via:'aborted'})
   release();await first;await second
   expect(body).not.toContain('event: error')
   await vi.waitFor(()=>expect(calls).toHaveLength(mode==='queued'?1:2),{timeout:15000})
   expect(JSON.stringify(calls.at(-1))).toContain('Keep the violet room note.')
   await vi.waitFor(async()=>expect((await fixture.pool.query('SELECT status FROM sessions WHERE id=$1',[session.id])).rows[0].status).not.toBe('running'),{timeout:15000})
   const settled=(await f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[session.id])).rows[0]
   expect(settled.status).not.toBe('running');expect(settled.turn_lease_token).toBeNull()
   expect((await f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'",[session.id])).rows).toHaveLength(mode==='disconnected'?2:1)
   const copies=(await f.pool.query("SELECT content FROM session_messages WHERE session_id=$1 AND role='user'",[session.id])).rows
    .filter(row=>JSON.stringify(row.content).includes('Keep the violet room note.'))
   expect(copies).toHaveLength(1)
   // A severed client settles early; retain fixture ownership through all
   // server-side follow-up work, rather than deleting its workspace at idle.
   if(mode==='disconnected')await vi.waitFor(()=>expect(finishedRequests).toBe(2),{timeout:15000})
  }finally{release();await first;await second}
 },60_000)
})
