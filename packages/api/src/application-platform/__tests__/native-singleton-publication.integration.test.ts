import {randomUUID} from 'node:crypto'
import express from 'express'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool} from '../../db/client.js'
import type {SessionMessage} from '../../db/sessions.js'
import {openAssistantTurn} from '../../turn/kernel.js'
import {policyFor} from '../../session-kind.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {closeProviderError} from '../../routes/chat-provider-error.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] singleton native-frame publication',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const sources=boundScopeSources(input)
  return{f,history,authority,sources,command:{sessionId:f.session.id,role:'assistant',content:'Fictional singleton response',senderAssistantId:f.assistantId,
   derivationTarget:f.envelope,authority,derivation:{producer:'fixture:singleton-frame',sources}}}
 }
 async function assertNoDebt(){
  for(const table of ['native_turn_publication_work','native_turn_publication_events','native_turn_publication_seals','native_turn_publication_debt']){
   expect((await getPool().query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,table).toBe(0)
  }
 }
 it('closes a provider error over growing derived history within unchanged SQL deadlines, and reads it through real loopback HTTP',async()=>{
  const {f}=await setup()
  expect((await getAppPool().query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('15s')
  let throughSequence=3
  for(let round=0;round<5;round++){
   const authority=await f.modelContext(f.firstId)
   const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence,authority})
   const [stored]=await publishNativeSessionMessageBatch({sessionId:f.session.id,messages:[{role:'assistant',content:`Fictional context step ${round}`}],
    authority,derivationTarget:f.envelope,derivation:{producer:'fixture:singleton-growth',sources:boundScopeSources(input)}})
   throughSequence=stored.sequenceNum
  }
  expect(throughSequence).toBe(8)
  const authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence,authority}),sources=boundScopeSources(input)
  const owner=await openAssistantTurn({sessionId:f.session.id,assistantId:f.assistantId,policy:policyFor(f.session),abortController:new AbortController()})
  let saved:SessionMessage|undefined,delivered:string|undefined
  const started=performance.now()
  const result=await closeProviderError({error:new Error('Stream idle for 90000ms (no deliverable chunk — prefill window)'),turns:[],hasDeliveredText:false,
   alreadyDelivered:false,signal:new AbortController().signal,canWrite:async()=>{await authority.execution.security.authority.assertCurrent();return true},
   persist:async text=>{[saved]=await owner.publish({disposition:'closing',native:authority,
    rows:[{role:'assistant',content:[{type:'text',text}],senderAssistantId:f.assistantId}],
    write:{derivationTarget:f.envelope,derivation:{producer:'fixture:singleton-provider-close',sources}},
    execute:operation=>authority.execution.security.authority.execute(operation)})},deliver:text=>{delivered=text}}).finally(()=>owner.finish('failed'))
  expect(performance.now()-started).toBeLessThan(15_000)
  expect(result).toBe(true);expect(saved).toMatchObject({sessionId:f.session.id,sequenceNum:9,role:'assistant'})
  expect(delivered).toBeTruthy();expect(boundScopeSources(saved!)).toMatchObject([{resourceKind:'session_message',resourceId:saved!.id}])
  expect((await f.pool.query('SELECT count(*)::integer n FROM native_turn_completions WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(0)
  const lineage=(await f.pool.query('SELECT kind,id,version FROM application_scope_lineage($1,$2,$3,$4)',[f.workspaceId,['session_message'],[saved!.id],['1']])).rows
  for(const source of sources)expect(lineage).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
  await assertNoDebt()
  const secret='fictional-singleton-http-secret',device=(await authSessionStore.create(f.firstId,{deviceLabel:'Fictional singleton browser',userAgent:null,ipAddress:null}))!
  const app=express();app.use('/sessions',requireAuth(secret),sessionRoutes())
  const server=app.listen(0,'127.0.0.1')
  try{
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
   const address=server.address();if(!address||typeof address==='string')throw new Error('Expected loopback TCP listener')
   const response=await fetch(`http://127.0.0.1:${address.port}/sessions/${f.session.id}/messages`,{headers:{Authorization:`Bearer ${createTokens(f.firstId,secret,device).accessToken}`}})
   expect(response.status).toBe(200)
   const messages=await response.json()
   if(!Array.isArray(messages))throw new Error('Expected HTTP message array')
   expect(messages.at(-1)).toMatchObject({id:saved!.id,content:[{type:'text',text:delivered}]})
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
 },60_000)
 it.each(['hold','edit','version'] as const)('refuses stale captured sources after a pre-write %s',async change=>{
  const {f,history,command}=await setup()
  if(change==='hold')await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[history[0].id])
  if(change==='edit')await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[history[0].id,JSON.stringify('Fictional changed input')])
  if(change==='version')command.derivation.sources=command.derivation.sources.map((source,index)=>index?source:{...source,version:'fictional-unrecorded-version'})
  await expect(publishNativeSessionMessage(command)).rejects.toThrow()
  expect((await f.pool.query('SELECT count(*)::integer n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(3)
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  await assertNoDebt()
 })
 it.each(['hold','edit'] as const)('rolls back both the singleton and its frame after a source %s during insertion',async change=>{
  const {f,history,command}=await setup(),name=`singleton_race_${randomUUID().replaceAll('-','')}`
  const mutation=change==='hold'?`UPDATE session_messages SET scope_held=true WHERE id='${history[0].id}'::uuid;`
   :`UPDATE session_messages SET content='"Fictional changed input"'::jsonb WHERE id='${history[0].id}'::uuid;`
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN ${mutation} RETURN NEW; END $fixture$`)
  try{
   await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_messages FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION ${name}()`)
   await expect(publishNativeSessionMessage(command)).rejects.toThrow()
   expect((await f.pool.query('SELECT count(*)::integer n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(3)
   expect((await f.pool.query('SELECT content,scope_held FROM session_messages WHERE id=$1',[history[0].id])).rows[0]).toEqual({content:history[0].content,scope_held:false})
   expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
   await assertNoDebt()
  }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_messages; DROP FUNCTION ${name}()`)}
 })
 it('retains the sealed canonical frame when constraints are already immediate',async()=>{
  const {f,command,authority,sources}=await setup()
  const stored=await withSessionMessagePublication(authority,sources,async db=>{await db.query('SET CONSTRAINTS ALL IMMEDIATE');return publishNativeSessionMessage(command,db)})
  expect(stored.sequenceNum).toBe(4)
  expect((await f.pool.query('SELECT session_id,format,manifest_digest FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows)
   .toEqual([{session_id:f.session.id,format:2,manifest_digest:expect.stringMatching(/^[a-f0-9]{64}$/)}])
  await assertNoDebt()
  const lineage=(await f.pool.query('SELECT kind,id,version FROM application_scope_lineage($1,$2,$3,$4)',[f.workspaceId,['session_message'],[stored.id],['1']])).rows
  for(const source of sources)expect(lineage).toContainEqual({kind:source.resourceKind,id:source.resourceId,version:source.version})
 })
 it('rolls back successful singleton SQL and all frame metadata when its enclosing operation fails',async()=>{
  const {f,command,authority,sources}=await setup()
  await expect(withSessionMessagePublication(authority,sources,async db=>{await publishNativeSessionMessage(command,db);throw new Error('Fictional enclosing failure')})).rejects.toThrow('Fictional enclosing failure')
  expect((await f.pool.query('SELECT count(*)::integer n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(3)
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  await assertNoDebt()
 })
 it('keeps genuine revocation sticky after restoration while a fresh independent writer remains usable',async()=>{
  const {f,command,authority}=await setup()
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(publishNativeSessionMessage(command)).rejects.toMatchObject({reason:'authority_changed'})
  await f.pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(authority.execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  const current=await f.modelContext(f.secondId)
  expect(await publishNativeSessionMessage({...command,authority:current})).toMatchObject({sequenceNum:4})
 })
})
