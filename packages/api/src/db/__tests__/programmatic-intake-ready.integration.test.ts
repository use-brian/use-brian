import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { withExternalKeyActor } from '../external-key-admission.js'
import pg from 'pg'
import { createProgrammaticEpisodeTerminal } from '../../ingest/programmatic-terminal.js'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createBatchWorker, type BatchStore, type LLMProvider } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'
import { createDbProgrammaticBatchStore } from '../pending-ingest-batches-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { programmaticCaptureRoutes } from '../../routes/programmatic-capture.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { createProgrammaticCaptureRouter, createProgrammaticBatchProcessor } from '../../ingest/programmatic-capture.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
process.env.PG_POOL_MAX='1'
const pool=getPool(), secret='test-only-capture-session-secret'
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(beforeExtract?:()=>Promise<void>, memories:object[]=[], entities:object[]=[], tasks:object[]=[], ephemeral:object[]=[] ) {
 const actor=randomUUID(), w=randomUUID(), a=randomUUID()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[actor])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Intake',$2,false)",[w,actor])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w,actor])
 await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Capture','primary','internal')",[a,w])
 const team=await createDbWorkspaceGroupStore().createTeam(actor,w,{name:'Shared',key:'shared'})
 const session=(await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id",[actor])).rows[0].id
 await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1",[w,team.id])
 const store=createProgrammaticCaptureStore(), app=express()
 app.use(express.json());app.use(requireAuth(secret))
 app.use('/w/:workspaceId/capture',programmaticCaptureRoutes({store,workspaceStore:createWorkspaceStore()}))
 const token=createTokens(actor,secret,{id:session,authVersion:0}).accessToken
 const post=(path:string,body:object)=>request(app).post(`/w/${w}/capture${path}`).auth(token,{type:'bearer'}).send(body)
 const profile=await post('',{name:'Configured',partitionBy:'session'})
 expect(profile.status,JSON.stringify(profile.body)).toBe(201)
 const p=profile.body.profile.id
 expect(profile.body.profile.intakeBinding.compartments).toEqual([team.compartmentKey])
 const rule=await post(`/${p}/rules`,{filterType:'always',routingMode:'scheduled',routingSchedule:'* * * * *'})
 expect(rule.status,JSON.stringify(rule.body)).toBe(201)
 const key=(await withExternalKeyActor(actor,session,()=>createDbBrainKeyStore().create({workspaceId:w,actingUserId:actor,name:'Fixture',scope:'read_write',maxClearance:'internal',contextGroupId:team.id,contextProjectId:null,captureAssistantId:a,captureProfileId:p}))).id
 const auth={keyId:key,workspaceId:w,scope:'read_write' as const,maxClearance:'internal' as const,authKind:'api_key' as const,storeScope:'none' as const,agentScope:'none' as const,captureAssistantId:a,captureProfileId:p}
 let providerCall=0
 const provider={name:'fixture',models:[],createSession(){throw new Error('not used')},async *stream(){
  const {programmaticIntakeClient}=await import('../programmatic-intake-context.js')
  const identity=(await programmaticIntakeClient.getStore()!.query(`SELECT current_setting('app.current_user_id',true) AS actor,current_setting('app.system_bypass',true) AS bypass`)).rows[0]
  expect(identity.actor).not.toBe(actor)
  expect(identity.bypass).not.toBe('true')
  await beforeExtract?.()
  providerCall++
  const extraction={summary:'Verified configured intake summary',entities,edges:[],memories,tasks,ephemeral,tags:[]}
  const readiness={assessments:tasks.map((t,index)=>({index,classification:'ready',evidence_quote:'Ship the pricing page update by Friday',commitment:'explicit',
   objective:'Ship the pricing page update',target:'Pricing page',description:'Update the pricing page by Friday. Start from the existing implementation. Done when live.',
   starting_point_kind:'discoverable',starting_point:'Locate the existing pricing page implementation.',completion_signal:'The updated pricing page is live.',missing:[],explanation:'Explicit commitment.'}))}
  yield {type:'text_delta',text:JSON.stringify(tasks.length && providerCall%2===0?readiness:extraction)}
  yield {type:'done'}
 }} as LLMProvider
 const ingest=vi.fn(createProgrammaticEpisodeTerminal({provider,model:'fixture-extractor'}))
 const enqueue=createProgrammaticCaptureRouter({store,ingest,now:()=>new Date('2020-01-01')})
 const process=createProgrammaticBatchProcessor({store,ingest,configuredIngest:ingest})
 const consume=()=>createDbProgrammaticBatchStore().withClaimedBatches(100,async(batches,mark)=>{
  for(const batch of batches){
   await process(batch)
   const {programmaticIntakeClient}=await import('../programmatic-intake-context.js')
   const execution=(await programmaticIntakeClient.getStore()!.query(`SELECT current_setting('app.current_user_id',true) AS actor,
    current_setting('app.system_bypass',true) AS bypass,current_setting('app.programmatic_candidate_source',true) AS proof,
    current_setting('app.programmatic_candidate',true) AS receipt`)).rows[0]
   expect(execution.actor).not.toBe(actor);expect(execution.bypass).not.toBe('true')
   expect(execution.proof??'').toBe('');expect(execution.receipt??'').toBe('')
   await mark(batch.id)
  }
  return batches.length
 })
 return {actor,w,a,key,session,team,p,post,enqueue,auth,ingest,consume,process,app,token}
}
describe('ready configured intake: production HTTP configuration, real enqueue and consumer',()=>{
 it('pins Simple intake through assistant default and mode changes, retries exactly once',async()=>{
  const f=await fixture()
  await f.enqueue(f.auth,{eventId:'one',sessionId:'source',content:'Pinned intake payload'})
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.w])
  await pool.query("UPDATE assistants SET default_compartments='{}',default_project_id=NULL WHERE id=$1",[f.a])
  expect((await f.post('',{name:'Unselected',partitionBy:'session'})).status).toBe(409)
  expect((await f.post('',{name:'Selected',partitionBy:'session',destination:{kind:'department',departmentId:f.team.id}})).status).toBe(201)
  const retry=await f.enqueue(f.auth,{eventId:'one',sessionId:'source',content:'Duplicate payload'})
  expect(retry.outcome).toBe('duplicate')
  expect(await f.consume()).toBe(1)
  expect(f.ingest).toHaveBeenCalledTimes(1)
  expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({compartments:[f.team.compartmentKey],projectIds:[],content:expect.stringContaining('Pinned intake payload')}))
  expect(await f.consume()).toBe(0)
  const published=(await pool.query(`SELECT e.id,e.user_id,e.assistant_id,e.compartments,e.summary_text,r.application_state,
   b.processed_at FROM episodes e JOIN pending_ingest_batches b ON b.id=e.programmatic_batch_id
   JOIN episode_extraction_runs r ON r.episode_id=e.id WHERE e.workspace_id=$1`,[f.w])).rows
  expect(published).toHaveLength(1)
  expect(published[0]).toMatchObject({user_id:null,assistant_id:f.a,compartments:[f.team.compartmentKey],summary_text:'Verified configured intake summary',application_state:'complete'})
  expect(published[0].processed_at).not.toBeNull()
 })
 it('serializes concurrent revoke and mode change with publication on max=1',async()=>{
  let entered!:()=>void,release!:()=>void
  const enteredPromise=new Promise<void>(r=>{entered=r}),resume=new Promise<void>(r=>{release=r})
  const f=await fixture(async()=>{entered();await resume},[{scope:'user',summary:'Derived fact',detail:'Source detail',tags:[],why_not_entity:'not an entity',why_not_task:'not a task'}],[{kind:'project',display_name:'Concurrent derived project',attributes:{}}])
  await f.enqueue(f.auth,{eventId:'race',sessionId:'source',content:'Concurrent publication'})
  const consuming=f.consume();await enteredPromise
  const other=new pg.Client({connectionString:process.env.DATABASE_URL});await other.connect()
  try {
   await other.query("SET lock_timeout='150ms'")
   await expect(other.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.key])).rejects.toMatchObject({code:'55P03'})
   await expect(other.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.w])).rejects.toMatchObject({code:'55P03'})
   release();expect(await consuming).toBe(1)
   await other.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.key])
   await other.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.w])
   expect(await f.consume()).toBe(0)
  } finally {release();await other.end()}
 })
 it('rolls back terminal failures and retries without duplicate Episode or extraction publication',async()=>{
  let failing=true
  const f=await fixture(async()=>{if(failing)throw new Error('controlled provider failure')})
  await f.enqueue(f.auth,{eventId:'retry',sessionId:'source',content:'Retry publication'})
  await expect(f.consume()).rejects.toThrow('capture_extraction_incomplete')
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  failing=false
  expect(await f.consume()).toBe(1)
  expect(await f.consume()).toBe(0)
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[f.w])).rows).toHaveLength(1)
 })
 it('does not resurrect old producer evidence when a key binding changes away and back',async()=>{
  const f=await fixture()
  await f.enqueue(f.auth,{eventId:'old-binding',sessionId:'source',content:'Old producer evidence'})
  await pool.query('UPDATE brain_keys SET capture_profile_id=NULL,capture_assistant_id=NULL WHERE id=$1',[f.key])
  await pool.query('UPDATE brain_keys SET capture_profile_id=$2,capture_assistant_id=$3 WHERE id=$1',[f.key,f.p,f.a])
  expect(await f.consume()).toBe(0)
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
 })
 it('rechecks wall-clock configuration expiry at commit and rolls back published rows',async()=>{
  const f=await fixture(undefined,[{scope:'user',summary:'Derived fact',detail:'Source detail',tags:[],why_not_entity:'not an entity',why_not_task:'not a task'}],[{kind:'project',display_name:'Concurrent derived project',attributes:{}}])
  await f.enqueue(f.auth,{eventId:'commit-expiry',sessionId:'source',content:'Expiry during publication'})
  // Set a short live lease before claiming. Locks cannot stop time advancing.
  await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[f.session])
  const terminal=createProgrammaticBatchProcessor({store:createProgrammaticCaptureStore(),ingest:f.ingest,configuredIngest:f.ingest})
  await expect(createDbProgrammaticBatchStore().withClaimedBatches(100,async(batches,mark)=>{
   for(const batch of batches){await terminal(batch);await mark(batch.id)}
   // All SQL publication succeeded; the deferred guard must still prevent COMMIT.
   const {programmaticIntakeClient}=await import('../programmatic-intake-context.js')
   await programmaticIntakeClient.getStore()!.query('SELECT pg_sleep(1.1)')
  })).rejects.toThrow('capture_binding_unavailable')
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  expect((await pool.query('SELECT id FROM episode_extraction_runs WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  for(const table of ['memories','entities','scope_derivations'])expect((await pool.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[f.w])).rows).toHaveLength(0)
 })
 it('publishes usual extracted memory and new entity candidates through canonical source-derived stores',async()=>{
  const f=await fixture(undefined,[{scope:'user',summary:'A durable extracted fact',detail:'Source detail',tags:[],why_not_entity:'not an entity',why_not_task:'not a task'}],[{kind:'project',display_name:'Intake project',canonical_id:null,attributes:{description:'Source project'}}])
  await f.enqueue(f.auth,{eventId:'fact',sessionId:'source',content:'A durable extracted fact'})
  expect(await f.consume()).toBe(1)
  for(const table of ['memories','entities']){
   const rows=(await pool.query(`SELECT user_id,assistant_id,compartments,source_episode_id FROM ${table} WHERE workspace_id=$1`,[f.w])).rows
   expect(rows).toHaveLength(1)
   expect(rows[0]).toMatchObject({user_id:null,assistant_id:f.a,compartments:[f.team.compartmentKey]})
   expect(rows[0].source_episode_id).toBeTruthy()
  }
  const lineage=(await pool.query("SELECT resource_kind FROM scope_derivations WHERE workspace_id=$1 ORDER BY resource_kind",[f.w])).rows
  expect(lineage).toEqual([{resource_kind:'entity'},{resource_kind:'memory'}])
  await pool.query('UPDATE episodes SET scope_held=true WHERE workspace_id=$1',[f.w])
  for(const table of ['memories','entities'])expect((await pool.query(`SELECT scope_held FROM ${table} WHERE workspace_id=$1`,[f.w])).rows).toEqual([{scope_held:true}])
 })
 it('publishes independently judged tasks only with the existing explicit allow rule',async()=>{
  const f=await fixture(undefined,[],[],[{text:'Ship the pricing page update',due_iso:null,assignee_ref:null}])
  await pool.query(`INSERT INTO task_rules(workspace_id,status,effect,predicate,origin,created_by_user_id)
   VALUES($1,'active','allow','{"lanes":["extracted"]}','user',$2)`,[f.w,f.actor])
  await f.enqueue(f.auth,{eventId:'task',sessionId:'source',content:'Ship the pricing page update by Friday'})
  expect(await f.consume()).toBe(1)
  const rows=(await pool.query('SELECT user_id,assistant_id,compartments,source_episode_id FROM tasks WHERE workspace_id=$1',[f.w])).rows
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({user_id:null,assistant_id:f.a,compartments:[f.team.compartmentKey]})
  expect((await pool.query("SELECT resource_kind FROM scope_derivations WHERE workspace_id=$1",[f.w])).rows).toEqual([{resource_kind:'task'}])
  await pool.query('UPDATE episodes SET scope_held=true WHERE workspace_id=$1',[f.w])
  expect((await pool.query('SELECT scope_held FROM tasks WHERE workspace_id=$1',[f.w])).rows).toEqual([{scope_held:true}])
 })
 it('rolls back earlier canonical candidate writes when a task is not admitted',async()=>{
  const f=await fixture(undefined,[],[{kind:'project',display_name:'Must roll back',attributes:{}}],[{text:'Ship the pricing page update',due_iso:null,assignee_ref:null}])
  await f.enqueue(f.auth,{eventId:'not-admitted',sessionId:'source',content:'Ship the pricing page update by Friday'})
  await expect(f.consume()).rejects.toThrow('capture_candidate_writer_required')
  for(const table of ['episodes','entities','tasks','scope_derivations','episode_extraction_runs'])expect((await pool.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[f.w])).rows).toHaveLength(0)
  expect((await pool.query('SELECT processed_at FROM pending_ingest_batches WHERE workspace_id=$1',[f.w])).rows).toEqual([{processed_at:null}])
  await pool.query('UPDATE pending_ingest_batches SET scope_held=true WHERE workspace_id=$1',[f.w])
 })
 it('actual poll worker rolls back a successful memory followed by an unsupported candidate and retries cleanly',async()=>{
  const unsupported=[{text:'Unsupported late candidate',reason:'other'}]
  const bad=await fixture(undefined,[{scope:'user',summary:'Must roll back',detail:'Source detail',tags:[],why_not_entity:'not an entity',why_not_task:'not a task'}],[],[],unsupported)
  const good=await fixture()
  await bad.enqueue(bad.auth,{eventId:'mixed-failure',sessionId:'source',content:'Durable source fact'})
  await good.enqueue(good.auth,{eventId:'healthy',sessionId:'source',content:'Healthy batch'})
  let memoryInserts=0
  const observedPool=new Proxy(pool,{get(target,key){
   if(key==='connect')return async()=>{
    const c=await pool.connect()
    return new Proxy(c,{get(client,property){
     if(property==='query')return async(...args:unknown[])=>{
      const result=await Reflect.apply(client.query,client,args)
      if(/INSERT INTO memories \(/.test(String(args[0])) && result.rows.length)memoryInserts++
      return result
     }
     const value=Reflect.get(client,property);return typeof value==='function'?value.bind(client):value
    }})
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const runWorker=async()=>{
   let done!:()=>void,fail!:(error:unknown)=>void
   const finished=new Promise<void>((resolve,reject)=>{done=resolve;fail=reject})
   const store=createDbProgrammaticBatchStore(observedPool)
   const observed:BatchStore={async withClaimedBatches(limit,handler){
    try{const result=await store.withClaimedBatches(limit,handler);done();return result}
    catch(error){fail(error);throw error}
   }}
   const worker=createBatchWorker({store:observed,intervalMs:3_600_000,processBatch:batch=>batch.workspaceId===bad.w?bad.process(batch):good.process(batch)})
   worker.start()
   try{await finished}finally{worker.stop()}
  }
  await runWorker()
  expect(memoryInserts).toBe(1) // proves the failure happened AFTER a real canonical INSERT
  for(const table of ['memories','entities','tasks','episodes','scope_derivations','episode_extraction_runs'])expect((await pool.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[bad.w])).rows).toHaveLength(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM episode_extraction_items i JOIN episode_extraction_runs r ON r.id=i.run_id WHERE r.workspace_id=$1',[good.w])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT processed_at FROM pending_ingest_batches WHERE workspace_id=$1',[bad.w])).rows).toEqual([{processed_at:null}])
  expect((await pool.query('SELECT status FROM programmatic_capture_receipts WHERE workspace_id=$1',[bad.w])).rows).toEqual([{status:'queued'}])
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[good.w])).rows).toHaveLength(1)
  unsupported.splice(0)
  await runWorker()
  expect(memoryInserts).toBe(2)
  for(const table of ['memories','episodes','episode_extraction_runs'])expect((await pool.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[bad.w])).rows).toHaveLength(1)
  expect((await pool.query('SELECT status FROM programmatic_capture_receipts WHERE workspace_id=$1',[bad.w])).rows).toEqual([{status:'completed'}])
 })
 it.each(['unprocessed','missing_item'] as const)('deferred publication guard rejects %s completion evidence',async fault=>{
  const f=await fixture()
  await f.enqueue(f.auth,{eventId:'guard',sessionId:'source',content:'Guard source'})
  await expect(createDbProgrammaticBatchStore().withClaimedBatches(100,async(batches,mark)=>{
   for(const batch of batches){
    await f.process(batch)
    if(fault==='missing_item'){
     const {programmaticIntakeClient}=await import('../programmatic-intake-context.js')
     await programmaticIntakeClient.getStore()!.query('DELETE FROM episode_extraction_items WHERE run_id IN (SELECT id FROM episode_extraction_runs WHERE workspace_id=$1)',[f.w])
     await mark(batch.id)
    }
   }
  })).rejects.toThrow('capture_publication_incomplete')
  expect((await pool.query('SELECT id FROM episodes WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  expect((await pool.query('SELECT id FROM episode_extraction_runs WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  expect((await pool.query('SELECT status FROM programmatic_capture_receipts WHERE workspace_id=$1',[f.w])).rows).toEqual([{status:'queued'}])
  expect(await f.consume()).toBe(1)
 })
 it('assigns and clears ready profiles through HTTP using the validated session',async()=>{
  const f=await fixture()
  const put=(profileId:string|null,token=f.token)=>request(f.app).put(`/w/${f.w}/capture/assistants/${f.a}/default`).auth(token,{type:'bearer'}).send({profileId})
  expect((await put(f.p)).status).toBe(204)
  expect((await pool.query('SELECT capture_profile_id FROM assistants WHERE id=$1',[f.a])).rows[0].capture_profile_id).toBe(f.p)
  expect((await put(null)).status).toBe(204)
  expect((await pool.query('SELECT capture_profile_id FROM assistants WHERE id=$1',[f.a])).rows[0].capture_profile_id).toBeNull()
  const legacy=createTokens(f.actor,secret).accessToken
  const denied=await put(f.p,legacy)
  expect(denied.status).toBe(409);expect(denied.body).toEqual({error:'Capture configuration unavailable'})
  expect((await pool.query('SELECT capture_profile_id FROM assistants WHERE id=$1',[f.a])).rows[0].capture_profile_id).toBeNull()
  await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.session])
  expect((await put(f.p)).status).toBe(401)
 })
 it('rejects a stale source binding and a held batch before handing payload to the consumer',async()=>{
  const f=await fixture()
  await f.enqueue(f.auth,{eventId:'stale',sessionId:'source',content:'Never delivered'})
  await pool.query('UPDATE brain_keys SET capture_profile_id=NULL,capture_assistant_id=NULL WHERE id=$1',[f.key])
  expect(await f.consume()).toBe(0);expect(f.ingest).not.toHaveBeenCalled()
  await expect(f.enqueue(f.auth,{eventId:'stale-new',sessionId:'source',content:'Never persisted'})).rejects.toThrow('capture_binding_unavailable')
  await pool.query('UPDATE pending_ingest_batches SET scope_held=true WHERE workspace_id=$1',[f.w])
  await pool.query('UPDATE brain_keys SET capture_profile_id=$2,capture_assistant_id=$3 WHERE id=$1',[f.key,f.p,f.a])
  expect(await f.consume()).toBe(0);expect(f.ingest).not.toHaveBeenCalled()
 })
 it('does not expose queued payload after exact source revocation',async()=>{
  const f=await fixture()
  await f.enqueue(f.auth,{eventId:'revoked',sessionId:'source',content:'Never delivered'})
  await pool.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.key])
  expect(await f.consume()).toBe(0);expect(f.ingest).not.toHaveBeenCalled()
  await expect(f.enqueue(f.auth,{eventId:'new',sessionId:'source',content:'Never persisted'})).rejects.toThrow('capture_binding_unavailable')
 })
 it('requires live per-call sessions and preserves explicit null/empty versus omission',async()=>{
  const f=await fixture()
  expect((await f.post('',{name:'Null',partitionBy:'session',destination:null})).status).not.toBe(201)
  expect((await f.post(`/${f.p}/rules`,{filterType:'always',routingMode:'scheduled',routingSchedule:'* * * * *',compartments:[]})).status).not.toBe(201)
  await f.enqueue(f.auth,{eventId:'expired',sessionId:'source',content:'Never delivered'})
  await pool.query("UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1",[f.session])
  expect(await f.consume()).toBe(0);expect(f.ingest).not.toHaveBeenCalled()
  expect((await f.post(`/${f.p}/rules`,{filterType:'always',routingMode:'drop'})).status).toBe(401)
 })
})
