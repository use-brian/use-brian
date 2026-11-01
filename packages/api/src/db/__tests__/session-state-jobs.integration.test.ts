import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { boundScopeSources, type LLMProvider } from '@use-brian/core'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { getAppPool, getPool } from '../client.js'
import { addSessionMessage } from '../sessions.js'
import { enqueueNativeSessionStateJob, claimSessionStateJob, finishSessionStateJob, sessionStateJobCurrent } from '../session-state-jobs.js'
import { createSessionStateWorker } from '../../workers/session-state-worker.js'
import { createDbSessionStateStore } from '../session-state-store.js'
import { readAdmittedSessionQuery } from '../session-query-reader.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
let f: Awaited<ReturnType<typeof persistentContextFixture>>
beforeEach(async () => { if (f) await f.cleanup(); f = await persistentContextFixture() })
afterAll(async () => { try { if (f) await f.cleanup() } finally { await getAppPool().end(); await getPool().end() } })
const ready = () => f.pool.query("UPDATE session_state_jobs SET available_at=now()-interval '1 second' WHERE session_id=$1", [f.session.id])
async function pair(question='Remember the fictional review',answer='I will keep that review open.') {
 const user = await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:question}],scope:f.envelope})
 const assistant = await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:answer}],senderAssistantId:f.assistantId,scope:f.envelope})
 const input = {authority:await f.modelContext(),claims:{userId:f.ownerId},userMessageId:user.id,assistantMessageId:assistant.id}
 expect(await enqueueNativeSessionStateJob(input)).toBe(true);await ready()
 return {user,assistant,input}
}
const state = async () => createDbSessionStateStore().listRecentBySession(f.session.id,50,await f.modelContext())
function worker(beforeReply: (request:any)=>Promise<void> = async()=>{},output='{"upserts":[{"key":"fixture:review","summary":"Review the fictional draft"}],"resolves":[]}') {
 const provider:LLMProvider={name:'fixture',models:['fixture'],createSession:()=>{throw new Error('unused')},stream:async function*(request){
  await beforeReply(request)
  yield {type:'text_delta',text:output}
  yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
 }}
 return createSessionStateWorker({resolveRuntime:async()=>({provider,model:'fixture',providerKeySource:'platform'}),recordResult:async()=>{}})
}
describe.sequential('[COMP:api/session-state-jobs] durable background commitment analysis',()=>{
 it('deduplicates an exchange, permits one worker and coalesces every unprocessed exchange',async()=>{
  const {input}=await pair();await enqueueNativeSessionStateJob(input)
  const jobs=await Promise.all([claimSessionStateJob(),claimSessionStateJob()])
  const claimed=jobs.filter(Boolean);expect(claimed).toHaveLength(1)
  const old=claimed[0]!
  expect(old).toMatchObject({generation:'1',firstSequence:1,throughSequence:2})
  await pair('The review is done.','Understood.')
  expect(await sessionStateJobCurrent(old)).toBe(false)
  await finishSessionStateJob(old);await ready()
  const next=(await claimSessionStateJob())!
  expect(next).toMatchObject({generation:'2',firstSequence:1,throughSequence:4})
  await finishSessionStateJob(next)
  await pair('Keep a new fictional decision open.','I will.')
  expect(await claimSessionStateJob()).toMatchObject({firstSequence:5,throughSequence:6})
 })
 it('does not claim during a foreground turn and fences new input before its completion enqueue',async()=>{
  await pair();await f.pool.query("UPDATE sessions SET status='running' WHERE id=$1",[f.session.id])
  expect(await claimSessionStateJob()).toBeNull()
  await f.pool.query("UPDATE sessions SET status='idle' WHERE id=$1",[f.session.id]);const job=(await claimSessionStateJob())!
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Actually cancel that.'}],scope:f.envelope})
  expect(await sessionStateJobCurrent(job)).toBe(false)
 })
 it('reclaims crashed work with a new token and bounds attempts',async()=>{
  await pair();const old=(await claimSessionStateJob())!
  await f.pool.query("UPDATE session_state_jobs SET locked_at=now()-interval '4 minutes' WHERE session_id=$1",[f.session.id])
  const reclaimed=(await claimSessionStateJob())!
  expect(reclaimed.leaseToken).not.toBe(old.leaseToken);expect(await sessionStateJobCurrent(old)).toBe(false)
  await finishSessionStateJob(old);expect(await sessionStateJobCurrent(reclaimed)).toBe(true)
  await f.pool.query("UPDATE session_state_jobs SET attempts=3,locked_at=now()-interval '4 minutes' WHERE session_id=$1",[f.session.id])
  expect(await claimSessionStateJob()).toBeNull()
  expect((await f.pool.query('SELECT status FROM session_state_jobs WHERE session_id=$1',[f.session.id])).rows[0].status).toBe('failed')
 })
 it('runs actual admitted inference and multiple canonical writes without a foreground lease',async()=>{
  await pair();let calls=0
  await worker(async()=>{
   calls++
   expect((await f.pool.query('SELECT status FROM sessions WHERE id=$1',[f.session.id])).rows[0].status).not.toBe('running')
  },'{"upserts":[{"key":"fixture:a","summary":"Review A"},{"key":"fixture:b","summary":"Review B"}],"resolves":[]}').tick()
  expect(calls).toBe(1);expect((await state()).map(row=>row.key).sort()).toEqual(['fixture:a','fixture:b'])
  expect((await f.pool.query('SELECT status FROM session_state_jobs WHERE session_id=$1',[f.session.id])).rows[0].status).toBe('done')
 })
 it('rejects a late result after a new message and reanalyzes both pending exchanges',async()=>{
  await pair();let calls=0
  await worker(async()=>{
   calls++
   await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Cancel the fictional review.'}],scope:f.envelope})
  }).tick()
  expect(calls).toBe(1);expect(await state()).toEqual([])
  await pair('The fictional review is cancelled.','There is nothing to keep open.')
  let reanalyzed=false
  await worker(async request=>{
   reanalyzed=true;const text=JSON.stringify(request.messages)
   expect(text).toContain('Remember the fictional review');expect(text).toContain('Cancel the fictional review.')
  },'{"upserts":[],"resolves":[]}').tick()
  expect(reanalyzed).toBe(true);expect(await state()).toEqual([])
 })
 it('rejects a stale absence conclusion after an explicit tool updates state during inference',async()=>{
  const {assistant}=await pair()
  await worker(async()=>{
   const authority=await f.modelContext()
   const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:assistant.sequenceNum,topicThroughSequence:0,authority})
   await createDbSessionStateStore().upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
    key:'fixture:explicit',summary:'New explicit commitment',source:'tool',authority,
    derivation:{producer:'fixture:explicit',sources:boundScopeSources(query)}})
  }).tick()
  expect((await state()).map(row=>row.key)).toEqual(['fixture:explicit'])
  expect((await f.pool.query('SELECT status FROM session_state_jobs WHERE session_id=$1',[f.session.id])).rows[0].status).toBe('pending')
 })
 it('treats an edited exchange with reused sequence numbers as a new generation',async()=>{
  await pair();const old=(await claimSessionStateJob())!
  await f.pool.query('DELETE FROM session_messages WHERE session_id=$1',[f.session.id])
  expect(await sessionStateJobCurrent(old)).toBe(false)
  await pair('Keep the edited fictional decision open.','I will remember the edited decision.')
  await finishSessionStateJob(old);await ready()
  expect(await claimSessionStateJob()).toMatchObject({generation:'2',firstSequence:1,throughSequence:2})
 })
 it('never infers commitments from text accompanying a tool call',async()=>{
  const user=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Check the fictional item.'}],scope:f.envelope})
  await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'PRIVATE TOOL NARRATION'},
   {type:'tool_use',id:'fictional-call',name:'fixture',input:{}}],senderAssistantId:f.assistantId,scope:f.envelope})
  const answer=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Final fictional answer.'}],senderAssistantId:f.assistantId,scope:f.envelope})
  await enqueueNativeSessionStateJob({authority:await f.modelContext(),claims:{userId:f.ownerId},userMessageId:user.id,assistantMessageId:answer.id});await ready()
  let called=false
  await worker(async request=>{called=true;expect(JSON.stringify(request.messages)).not.toContain('PRIVATE TOOL NARRATION');expect(JSON.stringify(request.messages)).toContain('Final fictional answer.')},'{"upserts":[],"resolves":[]}').tick()
  expect(called).toBe(true)
 })
 it('denies app-role queue access and removes jobs with the session',async()=>{
  await pair()
  expect((await f.pool.query("SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='session_state_jobs'::regclass")).rows[0].enabled).toBe(true)
  expect((await f.pool.query("SELECT has_table_privilege('app_user','session_state_jobs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed")).rows[0].allowed).toBe(false)
  await expect(getAppPool().query('SELECT * FROM session_state_jobs')).rejects.toMatchObject({code:'42501'})
  await f.pool.query('DELETE FROM sessions WHERE id=$1',[f.session.id])
  expect((await f.pool.query('SELECT 1 FROM session_state_jobs WHERE session_id=$1',[f.session.id])).rowCount).toBe(0)
 })
})
