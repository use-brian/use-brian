import { afterAll,beforeEach,describe,expect,it } from 'vitest'
import { createSessionTitleWorker,restrictTitleJobAuthority } from '../../workers/session-title-worker.js'
import { readSessionTitle,publishSessionTitle } from '../session-title-store.js'
import { readAdmittedSessionQuery } from '../session-query-reader.js'
import { boundScopeSources,type LLMProvider } from '@use-brian/core'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ContextScopeAccumulator } from '@use-brian/core'
import { getAppPool,getPool } from '../client.js'
import { enqueueNativeSessionTitleJob,claimSessionTitleJob,finishSessionTitleJob,sessionTitleJobCurrent } from '../session-title-jobs.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const f=await persistentContextFixture()
const authority={execution:await f.execution(),accumulator:new ContextScopeAccumulator()}
const input={authority,claims:{userId:f.ownerId},userMessageId:randomUUID()}
beforeEach(async()=>{await f.pool.query('DELETE FROM session_title_jobs WHERE session_id=$1',[f.session.id]);await f.pool.query("UPDATE sessions SET status='idle' WHERE id=$1",[f.session.id])})
afterAll(async()=>{try{await f.cleanup()}finally{await getAppPool().end();await getPool().end()}})
const ready=()=>f.pool.query("UPDATE session_title_jobs SET available_at=now()-interval '1 second' WHERE session_id=$1",[f.session.id])
describe.sequential('[COMP:api/session-title-jobs] durable queue ownership',()=>{
 it('revokes inherited table grants when the application role already exists',async()=>{
  const schema='title_queue_fixture_'+randomUUID().replaceAll('-','')
  const client=await f.pool.connect()
  try{
   await client.query(`CREATE SCHEMA ${schema}`)
   await client.query(`SET search_path TO ${schema},public`)
   await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO app_user`)
   for(const table of ['sessions','workspaces','assistants','users'])await client.query(`CREATE TABLE ${table}(id uuid PRIMARY KEY)`)
   await client.query(await readFile(new URL('../../../migrations/8153_session_title_jobs.sql',import.meta.url),'utf8'))
   expect((await client.query('SELECT has_table_privilege($1,$2,$3) AS allowed',['app_user',`${schema}.session_title_jobs`,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'])).rows[0].allowed).toBe(false)
   expect((await client.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[`${schema}.session_title_jobs`])).rows[0].relrowsecurity).toBe(true)
  }finally{
   await client.query('ROLLBACK');await client.query('RESET search_path')
   await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release()
  }
 })
 it('deduplicates one turn and lets only one concurrent worker claim it',async()=>{
  await enqueueNativeSessionTitleJob(input);await enqueueNativeSessionTitleJob(input);await ready()
  const jobs=await Promise.all([claimSessionTitleJob(),claimSessionTitleJob()])
  const claimed=jobs.filter(Boolean)
  expect(claimed).toHaveLength(1);expect(claimed[0]).toMatchObject({generation:'1',attempts:1})
  expect(await sessionTitleJobCurrent(claimed[0]!)).toBe(true)
 })
 it('enqueues and updates durable claims while ordinary readers hold shared parent locks',async()=>{
  const reader=await f.pool.connect()
  try{
   await reader.query('BEGIN')
   await reader.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[f.workspaceId])
   await reader.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE',[f.session.id])
   expect(await enqueueNativeSessionTitleJob(input)).toBe(true)
   await ready();const first=(await claimSessionTitleJob())!
   expect(first.generation).toBe('1')
   expect(await enqueueNativeSessionTitleJob({...input,userMessageId:randomUUID()})).toBe(true)
   expect(await sessionTitleJobCurrent(first)).toBe(false)
   await finishSessionTitleJob(first);await ready()
   expect((await claimSessionTitleJob())?.generation).toBe('2')
  }finally{await reader.query('ROLLBACK');reader.release()}
 })
 it('retains a newer enqueue when an older claim finishes',async()=>{
  await enqueueNativeSessionTitleJob(input);await ready();const old=(await claimSessionTitleJob())!
  await enqueueNativeSessionTitleJob({...input,userMessageId:randomUUID()})
  expect(await sessionTitleJobCurrent(old)).toBe(false)
  await finishSessionTitleJob(old);await ready()
  const next=(await claimSessionTitleJob())!
  expect(next.generation).toBe('2');expect(next.attempts).toBe(1)
  await finishSessionTitleJob(old,{terminal:true,code:'late_failure'})
  expect(await sessionTitleJobCurrent(next)).toBe(true)
 })
 it('reclaims a crashed lease with a new token and parks exhausted attempts',async()=>{
  await enqueueNativeSessionTitleJob(input);await ready();const first=(await claimSessionTitleJob())!
  await f.pool.query("UPDATE session_title_jobs SET locked_at=now()-interval '4 minutes' WHERE session_id=$1",[f.session.id])
  const second=(await claimSessionTitleJob())!
  expect(second.attempts).toBe(2);expect(second.leaseToken).not.toBe(first.leaseToken)
  await finishSessionTitleJob(first)
  expect(await sessionTitleJobCurrent(second)).toBe(true)
  await f.pool.query("UPDATE session_title_jobs SET attempts=3,locked_at=now()-interval '4 minutes' WHERE session_id=$1",[f.session.id])
  expect(await claimSessionTitleJob()).toBeNull()
  expect((await f.pool.query('SELECT status FROM session_title_jobs WHERE session_id=$1',[f.session.id])).rows[0].status).toBe('failed')
 })
 it('waits for foreground turns and prevents application-role queue reads',async()=>{
  await enqueueNativeSessionTitleJob(input);await ready()
  await f.pool.query("UPDATE sessions SET status='running' WHERE id=$1",[f.session.id])
  expect(await claimSessionTitleJob()).toBeNull()
  await expect(getAppPool().query('SELECT * FROM session_title_jobs')).rejects.toMatchObject({code:'42501'})
 })
 it.each(['enqueue','reclaim','finish'] as const)('serializes %s behind the canonical title publication commit',async mutation=>{
  const race=await persistentContextFixture()
  let release!:()=>void
  const resume=new Promise<void>(resolve=>{release=resolve})
  let reached!:()=>void
  const barrier=new Promise<void>(resolve=>{reached=resolve})
  let publication:Promise<unknown>|undefined,queued:Promise<unknown>|undefined
  try{
   const native=await race.modelContext()
   const request={authority:native,claims:{userId:race.ownerId},userMessageId:randomUUID()}
   await enqueueNativeSessionTitleJob(request)
   await race.pool.query("UPDATE session_title_jobs SET available_at=now()-interval '1 second' WHERE session_id=$1",[race.session.id])
   const job=(await claimSessionTitleJob())!
   expect(job.sessionId).toBe(race.session.id)
   const source=await readAdmittedSessionQuery({sessionId:race.session.id,throughSequence:0,topicThroughSequence:0,authority:native})
   const guarded=restrictTitleJobAuthority(native,job,()=>sessionTitleJobCurrent(job),new AbortController().signal)
   const current=guarded.execution.security.authority.assertCurrent
   let paused=false
   guarded.execution.security.authority.assertCurrent=async()=>{
    await current()
    // Detect the real final boundary rather than counting nested admission checks.
    const afterPublication=(await race.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
     AND state='idle in transaction' AND query LIKE 'SELECT publish_native_session_context_revision(%'`)).rowCount!==0
    if(afterPublication&&!paused){paused=true;reached();await resume}
   }
   publication=publishSessionTitle({sessionId:race.session.id,title:'Fictional serialized title',manual:false,expectedRevision:null,
    authority:guarded,derivation:{producer:'fixture:queued-title',sources:boundScopeSources(source)}}).catch(error=>error)
   await Promise.race([barrier,publication.then(result=>{throw result instanceof Error?result:new Error('Publication missed pre-commit barrier')})])
   if(mutation==='reclaim'){
    // Simulate lease time passing after its final currentness check.
    await race.pool.query("UPDATE session_title_jobs SET locked_at=now()-interval '4 minutes' WHERE session_id=$1",[race.session.id])
    expect(await claimSessionTitleJob()).toBeNull()
   }else{
    queued=mutation==='enqueue'?enqueueNativeSessionTitleJob({...request,userMessageId:randomUUID()}):finishSessionTitleJob(job).catch(error=>error)
    // Busy publication cannot be superseded, and queue retries release their
    // owner connection so the app-role transaction can finish its authority check.
    const result=await queued
    if(mutation==='enqueue')expect(result).toBe(false)
    else expect(result).toMatchObject({message:'title_queue_busy'})
   }
   expect((await race.pool.query('SELECT generation::text,status,lease_token FROM session_title_jobs WHERE session_id=$1',[race.session.id])).rows[0])
    .toMatchObject({generation:'1',status:'processing',lease_token:job.leaseToken})
   release();await publication;await queued
   expect((await race.pool.query('SELECT 1 FROM session_title_heads WHERE session_id=$1',[race.session.id])).rowCount).toBe(1)
   if(mutation==='enqueue'){
    expect(await enqueueNativeSessionTitleJob({...request,userMessageId:randomUUID()})).toBe(true)
    expect((await race.pool.query('SELECT generation::text FROM session_title_jobs WHERE session_id=$1',[race.session.id])).rows[0].generation).toBe('2')
   }
   if(mutation==='reclaim')expect((await claimSessionTitleJob())?.leaseToken).not.toBe(job.leaseToken)
   if(mutation==='finish'){
    await finishSessionTitleJob(job)
    expect((await race.pool.query('SELECT status FROM session_title_jobs WHERE session_id=$1',[race.session.id])).rows[0].status).toBe('done')
   }
  }finally{release();await publication;await queued;await race.cleanup()}
 })
 it('executes the real title path with freshly acquired authority and preserves a concurrent manual rename',async()=>{
  await f.history()
  await enqueueNativeSessionTitleJob(input);await ready()
  let called=0
  const provider:LLMProvider={name:'fixture',models:['fixture'],createSession:()=>{throw new Error('unused')},stream:async function*(){
   called++
   const manual=await f.modelContext()
   const sources=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,topicThroughSequence:0,authority:manual})
   expect(await publishSessionTitle({sessionId:f.session.id,title:'Fictional chosen manual title',manual:true,expectedRevision:null,authority:manual,
    derivation:{producer:'fixture:manual-title',sources:boundScopeSources(sources)}})).not.toBeNull()
   yield{type:'text_delta',text:'Fictional generated discussion title'}
   yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
  }}
  const worker=createSessionTitleWorker({resolveRuntime:async()=>({provider,model:'fixture',providerKeySource:'platform'}),recordUsage:async()=>{}})
  await worker.tick()
  expect(called).toBe(1)
  expect(await readSessionTitle(f.session.id,await f.modelContext())).toMatchObject({title:'Fictional chosen manual title',manual:true})
  expect((await f.pool.query('SELECT status FROM session_title_jobs WHERE session_id=$1',[f.session.id])).rows[0].status).toBe('done')
 })

})
